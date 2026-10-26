// ZONEFALL - first-person weapon and arms. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 6.4.
// "True arms": a soldier_a clone in an overlay Scene (rendered after the world with the depth buffer cleared, lit by
// the world's environment map plus a sun light that dims when the eye is in shadow), posed with the upper-body
// Rifle_Aim (pistol: Aim_Idle) clip. Everything except the arms is discarded per vertex from the skin weights, so
// gloved ACU sleeves hold the gun. The weapon GLB sits in WeaponSocket_R; every frame the rig is placed so the weapon
// lands exactly on the pose this module computes in camera space (hip / ADS / layers), and a two-bone IK keeps the
// left hand on the handguard (measured from the baked grip, shifted per weapon) or drives it through the reload,
// plate and grenade choreography.
// ADS: the sight line (TUNE.eye per weapon, from the IRONSIGHT / rear sight sockets) is placed on the camera axis.
// Layers: mouse sway (spring lag), walk/sprint bob from the controller gait, idle breathing, sprint carry pose, landing
// dip, recoil kick (spring, ARCHITECTURE.md 6.3 viewKickZ / viewKickRotDeg), per-shot bolt or slide cycling (slide
// locks back on empty), switch lower/raise, procedural reload (cant + dip, MAGAZINE node out and a fresh one in,
// charging handle racked on empty), M700 bolt cycle, plate insert, grenade cook and throw, swim lowered.
// FX in the overlay: muzzle flash cards + a point light at SOCKET_FX_FIRE, brass from the ejection port.
// The scope overlay (full-screen lens, duplex mil-dot reticle, edge vignette) is drawn here when state.local.scoped,
// offset by the scope sway from combat/weapons; the viewmodel itself is hidden then and outside first person.
// Extra exports: getOverlay() -> {scene, camera}, scopeOverlayVisible(), setScopeOverlay(on).
import * as THREE from 'three';
import { WEAPONS, RENDER, PLAYER } from '../config.js';
import { on, EV } from '../core/bus.js';
import { state, gfx, localPlayer, LIFE, FLAG, hasFlag, debug } from '../core/state.js';
import { clamp, damp, lerp, smoothstep, DEG } from '../core/util.js';
import * as renderer from '../engine/renderer.js';
import * as assets from '../engine/assets.js';
import * as input from '../engine/input.js';
import * as world from '../world/world.js';
import * as controller from '../player/controller.js';
import * as weapons from './weapons.js';
import * as vfx from './vfx.js';

const TUNE = {
  near: 0.01, far: 40,
  vmFovFollow: 0.55,          // share of the ADS zoom the viewmodel follows (1 = same FOV as the world)
  // ADS eye point per weapon (weapon space: y = sight line height, z = eye relief behind the grip)
  eye: { ak47: [0, 0.1475, 0.12], m4a1: [-0.001, 0.1425, 0.165], mp5: [0, 0.1835, 0.10], m700: [0, 0.0972, 0.115], m1911: [0, 0.0885, 0.34] },
  // Left-hand grip shift on the handguard (weapon space, added to the baked Rifle_Aim grip)
  gripShift: { ak47: [0, -0.004, -0.06], m4a1: [0, 0, -0.03], mp5: [0, 0.012, 0.025], m700: [0, -0.012, -0.08] },
  pose: {
    rifle: {
      hip: [0.118, -0.098, -0.05], hipRot: [0.01, 0.04, -0.07],
      sprint: { pos: [0.0, 0.01, -0.03], rot: [-0.28, 0.62, 0.38] },
      reload: { pos: [-0.06, 0.09, -0.07], rot: [0.36, 0.12, -0.72] },
      lower: { pos: [0.03, -0.26, 0.06], rot: [-0.95, 0.3, 0.25] },
      plate: { pos: [0.03, -0.045, 0.015], rot: [-0.14, -0.16, -0.36] },
      nade: { pos: [0.035, -0.05, 0.02], rot: [-0.18, -0.18, -0.3] },
      swim: { pos: [0.02, -0.3, 0.05], rot: [-1.0, 0.2, 0.2] },
    },
    pistol: {
      hip: [0.07, -0.092, -0.03], hipRot: [0.02, 0.05, -0.05],
      sprint: { pos: [0.0, -0.04, 0.0], rot: [-0.7, 0.3, 0.1] },
      reload: { pos: [-0.035, 0.035, 0.02], rot: [0.42, 0.24, -0.38] },
      lower: { pos: [0.02, -0.25, 0.08], rot: [-1.05, 0.2, 0.15] },
      plate: { pos: [0.05, -0.08, 0.04], rot: [-0.55, -0.15, -0.2] },
      nade: { pos: [0.06, -0.1, 0.04], rot: [-0.6, -0.2, -0.2] },
      swim: { pos: [0.02, -0.3, 0.08], rot: [-1.1, 0.2, 0.1] },
    },
  },
  sway: { k: 160, c: 17, perPx: 0.0011, max: 0.09, posK: 0.18 },
  bob: { amp: 0.011, sprintAmp: 0.024, adsMult: 0.12 },
  breath: { amp: 0.0022, rate: 1.4 },
  kick: { k: 330, c: 26, adsMult: 0.55 },
  land: { k: 120, c: 13 },
  boltTravel: { ak47: 0.075, m4a1: 0.06, mp5: 0.05, m700: 0.085, m1911: 0.032 },
  shotCycle: 0.055,
  armCut: 0.5,
  flash: { life: 0.05, light: 3.5 },
  casings: 10,
  scope: { radius: 0.9, edge: 0.03 },
  sunShadowEvery: 5,
  // left-hand paths in camera space [t, x, y, z] (plate: t = fraction of the insert time; throw: seconds)
  platePath: [[0, -0.08, -0.3, -0.35], [0.12, -0.2, -0.42, -0.25], [0.38, -0.1, -0.235, -0.42], [0.62, -0.05, -0.26, -0.38], [0.8, -0.02, -0.5, -0.22], [1, -0.02, -0.5, -0.22]],
  plateHold: [0.06, 0.06, -0.02],      // plate centre from the palm (camera space)
  throwPath: [[0, -0.16, -0.14, -0.33], [0.08, -0.24, -0.03, -0.16], [0.17, -0.07, -0.02, -0.46], [0.3, 0.03, -0.24, -0.42], [0.55, -0.04, -0.46, -0.3]],
};
const ARM_BONES = /UpperArm|Forearm|Hand|Finger/;

let inited = false;
let ovScene = null, ovCam = null, view = null, rigRoot = null, rig = null, mixer = null;
let actions = {};
let curClip = null;
let bones = null;
let gripRel = { rifle: new THREE.Matrix4(), pistol: new THREE.Matrix4() };
const wcache = new Map();      // weapon id -> {group, mag, bolt, muzzle, casing, magPos, boltPos, boltRot, eye}
let cur = null;                // current weapon record
let externalVisible = true;
let sun = null, flashLight = null;
let sunK = 1, sunCheck = 0;
let flash = null, flashT = 1;
let casings = null;
let scope = null;
let plateMesh = null, fragMesh = null;
let visibleNow = false;
// springs
const sway = { x: 0, y: 0, vx: 0, vy: 0 };
const kickS = { z: 0, vz: 0, p: 0, vp: 0, r: 0, vr: 0, y: 0, vy: 0 };
const land = { y: 0, v: 0 };
let shotT = 1, slideLock = false, breathT = 0;
let bobX = 0, bobY = 0;

// temporaries
const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4(), m3 = new THREE.Matrix4(), mSock = new THREE.Matrix4(), mRigInv = new THREE.Matrix4();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), vt = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), qp = new THREE.Quaternion(), qt = new THREE.Quaternion();
const e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const s1 = new THREE.Vector3();
const ikU = new THREE.Vector3(), ikW = new THREE.Vector3(), ikN = new THREE.Vector3(), ikP = new THREE.Vector3(), ikE = new THREE.Vector3();

function err(msg) { return new Error(`[COMBAT/viewmodel] ${msg}`); }
const isPistol = (id) => !!id && WEAPONS[id] && WEAPONS[id].class === 'pistol';

// ------------------------------------------------------------------------------------------ arms rig
function armsMaterial(src) {
  const m = src.clone();
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float armW;\nvarying float vArmW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvArmW = armW;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vArmW;')
      .replace('void main() {', `void main() {\n\tif (vArmW < ${TUNE.armCut.toFixed(3)}) discard;`);
  };
  m.customProgramCacheKey = () => 'zf-vm-arms';
  return m;
}

function buildRig() {
  rig = assets.cloneModel('soldier_a');
  rigRoot = new THREE.Group();
  rigRoot.matrixAutoUpdate = false;
  rigRoot.add(rig);
  view.add(rigRoot);
  const meshes = [];
  rig.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  if (!meshes.length) throw err('soldier_a has no skinned meshes');
  let bodyFound = false;
  for (const sm of meshes) {
    sm.frustumCulled = false;
    sm.castShadow = false; sm.receiveShadow = false;
    const name = (sm.material && sm.material.name) || '';
    if (!/body/i.test(name)) { sm.visible = false; continue; }
    bodyFound = true;
    const g = sm.geometry.clone();
    const bonesArr = sm.skeleton.bones;
    const isArm = bonesArr.map((b) => ARM_BONES.test(b.name));
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    const w = new Float32Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let s = 0;
      if (isArm[si.getX(i)]) s += sw.getX(i);
      if (isArm[si.getY(i)]) s += sw.getY(i);
      if (isArm[si.getZ(i)]) s += sw.getZ(i);
      if (isArm[si.getW(i)]) s += sw.getW(i);
      w[i] = s;
    }
    g.setAttribute('armW', new THREE.BufferAttribute(w, 1));
    sm.geometry = g;
    sm.material = armsMaterial(sm.material);
  }
  if (!bodyFound) throw err('soldier_a body material not found');
  const B = (n) => { const b = rig.getObjectByName(n); if (!b) throw err(`bone ${n} missing`); return b; };
  bones = {
    socket: B('WeaponSocket_R'), lUpper: B('Bip01_L_UpperArm'), lFore: B('Bip01_L_Forearm'), lHand: B('Bip01_L_Hand'),
    rUpper: B('Bip01_R_UpperArm'), rFore: B('Bip01_R_Forearm'), rHand: B('Bip01_R_Hand'), head: B('Bip01_Head'),
  };
  mixer = new THREE.AnimationMixer(rig);
  const clips = assets.clips();
  const upper = (name) => {
    const c = clips[name];
    if (!c) throw err(`clip ${name} missing`);
    const u = c.clone();
    u.tracks = u.tracks.filter((t) => /Spine1|Spine2|Neck|Head|Clavicle|UpperArm|Forearm|Hand|Finger|WeaponSocket/.test(t.name));
    return u;
  };
  actions.rifle = mixer.clipAction(upper('Rifle_Aim'));
  actions.pistol = mixer.clipAction(upper('Aim_Idle'));
  for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
  // Measure the baked left-hand grips relative to the weapon socket.
  for (const kind of ['rifle', 'pistol']) {
    setClip(kind, true);
    mixer.update(0);
    rigRoot.updateMatrixWorld(true);
    gripRel[kind] = new THREE.Matrix4().copy(bones.socket.matrixWorld).invert().multiply(bones.lHand.matrixWorld);
  }
  setClip('rifle', true);
}

function setClip(kind, instant = false) {
  if (curClip === kind) return;
  curClip = kind;
  for (const [k, a] of Object.entries(actions)) {
    if (instant) a.setEffectiveWeight(k === kind ? 1 : 0);
    else if (k === kind) { a.enabled = true; a.setEffectiveWeight(1); } else a.setEffectiveWeight(0);
  }
}

// ------------------------------------------------------------------------------------------ weapons
const matCache = new Map();
function vmMaterial(m) {
  if (!m) return m;
  if (Array.isArray(m)) return m.map(vmMaterial);
  let c = matCache.get(m);
  if (!c) { c = m.clone(); matCache.set(m, c); }
  return c;
}

function buildWeapon(id) {
  if (wcache.has(id)) return wcache.get(id);
  const W = WEAPONS[id];
  if (!W || !W.model || W.class === 'lethal') return null;
  const group = assets.model(W.model.key).scene.clone(true);
  group.name = 'vm:' + id;
  group.traverse((o) => { if (o.isMesh) { o.material = vmMaterial(o.material); o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
  if (W.model.scope) {
    const sc = W.model.scope;
    const sg = assets.model(sc.key).scene;
    sg.updateMatrixWorld(true);
    const node = sg.getObjectByName(sc.node);
    if (!node) throw err(`scope node '${sc.node}' not found`);
    const sInv = new THREE.Matrix4().copy(sg.matrixWorld).invert();
    const sc3 = node.clone(true);
    sc3.matrixAutoUpdate = false;
    sc3.matrix.multiplyMatrices(new THREE.Matrix4().makeTranslation(sc.offset[0], sc.offset[1], sc.offset[2]), m1.multiplyMatrices(sInv, node.matrixWorld));
    sc3.traverse((o) => { if (o.isMesh) { o.material = vmMaterial(o.material); o.frustumCulled = false; } });
    group.add(sc3);
  }
  const find = (n) => (n ? group.getObjectByName(n) : null);
  const mag = find(W.model.mag), bolt = find(W.model.bolt);
  const muzzle = find(W.model.muzzle) || (() => { const o = new THREE.Object3D(); o.position.set(0, 0.07, -0.6); group.add(o); return o; })();
  const casing = find(W.model.casing) || muzzle;
  const rec = {
    id, W, group, mag, bolt, muzzle, casing,
    magPos: mag ? mag.position.clone() : null, magQuat: mag ? mag.quaternion.clone() : null,
    boltPos: bolt ? bolt.position.clone() : null, boltQuat: bolt ? bolt.quaternion.clone() : null,
    eye: new THREE.Vector3(...(TUNE.eye[id] || W.model.eye || [0, 0.1, 0.1])),
    gripShift: new THREE.Vector3(...(TUNE.gripShift[id] || [0, 0, 0])),
    pistol: W.class === 'pistol',
  };
  group.visible = false;
  wcache.set(id, rec);
  return rec;
}

function equip(id) {
  if (cur && cur.id === id) return;
  if (cur) { cur.group.visible = false; cur.group.removeFromParent(); }
  cur = id ? buildWeapon(id) : null;
  if (cur) {
    bones.socket.add(cur.group);
    cur.group.position.set(0, 0, 0); cur.group.quaternion.identity(); cur.group.scale.set(1, 1, 1);
    cur.group.visible = true;
    setClip(cur.pistol ? 'pistol' : 'rifle');
    if (cur.mag) { cur.mag.visible = true; cur.mag.position.copy(cur.magPos); cur.mag.quaternion.copy(cur.magQuat); }
    slideLock = false;
  }
}

// ------------------------------------------------------------------------------------------ props in hand, fx
/** Armor plate insert: cordura cover (procedural weave + stitching + spec label) with a matching normal map. */
function plateTextures() {
  const N = 256;
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  const n = document.createElement('canvas'); n.width = n.height = N;
  const gn = n.getContext('2d');
  g.fillStyle = '#5f5642'; g.fillRect(0, 0, N, N);
  gn.fillStyle = 'rgb(128,128,255)'; gn.fillRect(0, 0, N, N);
  // basket weave: alternating light/dark threads, mirrored into the normal map as small ridges
  for (let y = 0; y < N; y += 2) {
    for (let x = 0; x < N; x += 2) {
      const over = ((x >> 1) + (y >> 1)) & 1;
      const j = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      const l = 0.9 + 0.12 * over + 0.06 * j;
      g.fillStyle = `rgb(${(95 * l) | 0},${(86 * l) | 0},${(66 * l) | 0})`;
      g.fillRect(x, y, 2, 2);
      gn.fillStyle = over ? 'rgb(150,128,240)' : 'rgb(128,150,240)';
      gn.fillRect(x, y, 2, 2);
    }
  }
  // grime toward the edges, stitched border, spec label (white panel, black text)
  const rg = g.createRadialGradient(N / 2, N / 2, N * 0.2, N / 2, N / 2, N * 0.75);
  rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(20,16,10,0.45)');
  g.fillStyle = rg; g.fillRect(0, 0, N, N);
  g.setLineDash([5, 4]); g.strokeStyle = 'rgba(40,34,24,0.9)'; g.lineWidth = 2;
  g.strokeRect(10, 10, N - 20, N - 20);
  gn.setLineDash([5, 4]); gn.strokeStyle = 'rgb(128,100,250)'; gn.lineWidth = 3; gn.strokeRect(10, 10, N - 20, N - 20);
  g.setLineDash([]);
  g.fillStyle = 'rgba(214,208,192,0.92)'; g.fillRect(64, 150, 128, 58);
  g.fillStyle = '#1d1c19'; g.font = '700 17px "Barlow Condensed", Arial, sans-serif'; g.textAlign = 'center';
  g.fillText('LEVEL IV  STAND ALONE', 128, 172);
  g.font = '500 11px "JetBrains Mono", monospace';
  g.fillText('SA-PL4 / 10 x 12 / 2.6 KG', 128, 188);
  g.fillText('THIS SIDE TOWARD BODY', 128, 202);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const nor = new THREE.CanvasTexture(n); nor.anisotropy = 4;
  return { map, nor };
}

function buildProps() {
  const g = new THREE.BoxGeometry(0.25, 0.31, 0.024, 6, 6, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    // multi-curve plate with chamfered top corners (shooter's cut)
    let px = x;
    const top = clamp((y - 0.08) / 0.075, 0, 1);
    px *= 1 - 0.32 * top * top;
    pos.setX(i, px);
    pos.setZ(i, pos.getZ(i) - (px * px * 1.4 + y * y * 0.35) * 0.35);
  }
  g.computeVertexNormals();
  const pt = plateTextures();
  plateMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: pt.map, normalMap: pt.nor, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.92, metalness: 0 }));
  plateMesh.visible = false;
  fragMesh = assets.cloneModel(WEAPONS.frag.model.key);
  fragMesh.traverse((o) => { if (o.isMesh) { o.material = vmMaterial(o.material); o.frustumCulled = false; } });
  fragMesh.visible = false;
  view.add(plateMesh, fragMesh);
  // muzzle flash cards (front star + two crossed side flames) and a point light
  const tx = vfx.textures();
  const fm = new THREE.MeshBasicMaterial({ map: tx.flashFront, color: new THREE.Color(2.6, 2.1, 1.5), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const sm = new THREE.MeshBasicMaterial({ map: tx.flashSide, color: new THREE.Color(2.4, 1.8, 1.25), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  flash = new THREE.Group();
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fm);
  front.name = 'front';
  const sg = new THREE.PlaneGeometry(1, 0.42); sg.rotateY(Math.PI / 2); sg.translate(0, 0, -0.5);
  const sideA = new THREE.Mesh(sg, sm), sideB = new THREE.Mesh(sg, sm);
  sideB.rotation.z = Math.PI / 2;
  flash.add(front, sideA, sideB);
  flash.traverse((o) => { o.renderOrder = 10; o.frustumCulled = false; });
  flash.visible = false;
  view.add(flash);
  flashLight = new THREE.PointLight(0xffa040, 0, 2.5, 2);
  view.add(flashLight);
  // brass
  const cg = new THREE.CylinderGeometry(0.0055, 0.0055, 0.04, 10, 1);
  cg.rotateZ(Math.PI / 2);
  const cmesh = new THREE.InstancedMesh(cg, new THREE.MeshStandardMaterial({ color: 0xd2aa5a, metalness: 1, roughness: 0.28 }), TUNE.casings);
  cmesh.frustumCulled = false; cmesh.count = 0;
  cmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  view.add(cmesh);
  casings = { mesh: cmesh, list: Array.from({ length: TUNE.casings }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), t: 9 })), next: 0 };
}

function buildScope() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOffset: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uAlpha: { value: 0 }, uR: { value: TUNE.scope.radius }, uBreath: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform vec2 uOffset; uniform float uAspect; uniform float uAlpha; uniform float uR; uniform float uBreath;
      float line(float d, float w) { return 1.0 - smoothstep(w, w + 0.0025, d); }
      void main() {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
        vec2 q = p - uOffset;
        float r = length(q);
        // lens: black outside, a soft dark ring at the edge, slight dimming toward the rim (eye relief shadow)
        float inside = 1.0 - smoothstep(uR - 0.012, uR, r);
        float rim = smoothstep(uR * 0.62, uR, r);
        float shade = mix(0.0, 0.62, rim * rim);
        // duplex reticle: thin centre, thick posts beyond 0.32, mil dots every 0.07
        float thick = 0.0105, thin = 0.0016;
        float wx = abs(q.x) > 0.32 ? thick : thin;
        float wy = abs(q.y) > 0.32 ? thick : thin;
        float ret = max(line(abs(q.y), wx) * step(abs(q.x), uR), line(abs(q.x), wy) * step(abs(q.y), uR));
        float dots = 0.0;
        for (int i = 1; i <= 4; i++) {
          float s = float(i) * 0.07;
          dots = max(dots, 1.0 - smoothstep(0.0055, 0.008, length(vec2(abs(q.x) - s, q.y))));
          dots = max(dots, 1.0 - smoothstep(0.0055, 0.008, length(vec2(q.x, abs(q.y) - s))));
        }
        ret = max(ret, dots * step(abs(q.x) + abs(q.y), 0.3));
        float a = mix(1.0, max(shade, ret * 0.92), inside);
        // faint lens tint near the centre when the breath is held
        gl_FragColor = vec4(vec3(0.0), a * uAlpha);
      }
    `,
    transparent: true, depthTest: false, depthWrite: false,
  });
  scope = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  scope.renderOrder = 100;
  scope.frustumCulled = false;
  scope.visible = false;
  view.add(scope);
}

// ------------------------------------------------------------------------------------------ public API
export function init() {
  if (inited) return;
  if (!gfx.camera) throw err('init before renderer');
  ovScene = new THREE.Scene();
  ovCam = new THREE.PerspectiveCamera(gfx.camera.fov, gfx.camera.aspect, TUNE.near, TUNE.far);
  view = new THREE.Group();
  view.matrixAutoUpdate = false;
  ovScene.add(view);
  sun = new THREE.DirectionalLight(RENDER.sunColor, RENDER.sunIntensity * 0.8);
  ovScene.add(sun, sun.target);
  buildRig();
  buildProps();
  buildScope();
  inited = true;
  renderer.setOverlay(ovScene, ovCam);
  on(EV.WEAPON_FIRE, (e) => { if (e.local) onLocalFire(e); });
  on(EV.PLAYER_LAND, ({ id, speed }) => { if (id === state.selfId) land.v -= clamp((speed || 0) * 0.03, 0, 0.35); });
  on(EV.WEAPON_RELOAD, ({ id, phase }) => { if (id === state.selfId && (phase === 'magin' || phase === 'end')) slideLock = false; });
  on(EV.MATCH_START, () => { slideLock = false; kickS.z = kickS.p = kickS.r = kickS.y = 0; });
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    viewmodel: () => ({ visible: visibleNow, weapon: cur ? cur.id : null, scope: scope.visible, sunK: +sunK.toFixed(2) }),
    viewmodelTune: TUNE,
  });
}

/** Recoil kick for one shot of weaponId. */
export function kick(weaponId) { kickImpl(weaponId); }
function kickImpl(weaponId) {
  const W = WEAPONS[weaponId];
  if (!W || !W.recoil) return;
  const r = W.recoil;
  const ads = state.local.ads || 0;
  const m = lerp(1, TUNE.kick.adsMult, ads);
  kickS.vz += r.viewKickZ * 30 * m;
  kickS.vp += r.viewKickRotDeg * DEG * 26 * m;
  kickS.vr += (Math.random() - 0.5) * r.viewKickRotDeg * DEG * 12 * m;
  kickS.vy += (Math.random() - 0.5) * r.viewKickRotDeg * DEG * 8 * m;
  shotT = 0;
  const slot = state.local.inv && state.local.inv.slots[state.local.inv.active];
  if (W.class === 'pistol' && slot && slot.mag === 0) slideLock = true;
}

/** Approximate world-space muzzle position of the first-person weapon into out (THREE.Vector3); returns out, or null when hidden. */
export function getMuzzle(out) {
  if (!inited || !cur || !visibleNow) return null;
  cur.muzzle.updateWorldMatrix(true, false);
  out.setFromMatrixPosition(cur.muzzle.matrixWorld);
  // Re-project from the viewmodel frustum into the world camera's so tracers start where the muzzle is drawn.
  v1.copy(out).applyMatrix4(m1.copy(gfx.camera.matrixWorld).invert());
  const k = Math.tan(gfx.camera.fov * 0.5 * DEG) / Math.tan(ovCam.fov * 0.5 * DEG);
  v1.x *= k; v1.y *= k;
  return out.copy(v1).applyMatrix4(gfx.camera.matrixWorld);
}

export function setVisible(on) { externalVisible = !!on; }

/** The overlay scene and camera (registered with renderer.setOverlay at init). */
export function getOverlay() { return { scene: ovScene, camera: ovCam }; }
export function scopeOverlayVisible() { return !!(scope && scope.visible); }
/** The 3D scope lens + reticle (with sway) is drawn here by default; pass false if the UI draws its own scope. */
export function setScopeOverlay(on) { scopeEnabled = !!on; }
let scopeEnabled = true;

// ------------------------------------------------------------------------------------------ helpers
function spring(s, key, vkey, target, k, c, dt) {
  // semi-implicit Euler, sub-stepped for stability at low frame rates
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s[vkey] += (-(s[key] - target) * k - s[vkey] * c) * h;
    s[key] += s[vkey] * h;
  }
}

function rotateBoneWorld(bone, q) {
  bone.parent.getWorldQuaternion(qp);
  q2.copy(qp).invert().multiply(q).multiply(qp);
  bone.quaternion.premultiply(q2);
  bone.updateMatrixWorld(true);
}
function setBoneWorldQuat(bone, qW) {
  bone.parent.getWorldQuaternion(qp);
  bone.quaternion.copy(qp.invert().multiply(qW));
  bone.updateMatrixWorld(true);
}

function ikTwoBone(upper, lower, end, target, poleW, weight) {
  upper.getWorldPosition(va); lower.getWorldPosition(vb); end.getWorldPosition(vc);
  vt.lerpVectors(vc, target, clamp(weight, 0, 1));
  const l1 = va.distanceTo(vb), l2 = vb.distanceTo(vc);
  if (l1 < 1e-4 || l2 < 1e-4) return;
  const d = clamp(va.distanceTo(vt), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  ikU.subVectors(va, vb); ikW.subVectors(vc, vb);
  const curA = ikU.angleTo(ikW);
  const des = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  ikN.crossVectors(ikU, ikW);
  if (ikN.lengthSq() < 1e-10) ikN.subVectors(vt, va).cross(ikP.subVectors(poleW, va));
  if (ikN.lengthSq() < 1e-10) return;
  ikN.normalize();
  q1.setFromAxisAngle(ikN, des - curA);
  rotateBoneWorld(lower, q1);
  end.getWorldPosition(vc);
  ikU.subVectors(vc, va).normalize();
  ikW.subVectors(vt, va).normalize();
  q1.setFromUnitVectors(ikU, ikW);
  rotateBoneWorld(upper, q1);
  lower.getWorldPosition(vb);
  ikE.subVectors(vb, va); ikP.subVectors(poleW, va);
  ikE.addScaledVector(ikW, -ikE.dot(ikW));
  ikP.addScaledVector(ikW, -ikP.dot(ikW));
  if (ikE.lengthSq() > 1e-8 && ikP.lengthSq() > 1e-8) {
    ikE.normalize(); ikP.normalize();
    let ang = Math.acos(clamp(ikE.dot(ikP), -1, 1));
    ikN.crossVectors(ikE, ikP);
    if (ikN.dot(ikW) < 0) ang = -ang;
    q1.setFromAxisAngle(ikW, ang * 0.85);
    rotateBoneWorld(upper, q1);
  }
}

/** Pose blend helper: accumulate a pose {pos, rot} scaled by w into acc. */
function addPose(acc, p, w) {
  if (w <= 0) return;
  acc.px += p.pos[0] * w; acc.py += p.pos[1] * w; acc.pz += p.pos[2] * w;
  acc.rx += p.rot[0] * w; acc.ry += p.rot[1] * w; acc.rz += p.rot[2] * w;
}

/** Smoothstep-eased keyframe path [[t, x, y, z], ...] sampled at t into out. */
function keyPath(keys, t, out) {
  if (t <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b[0]) {
      const a = keys[i - 1];
      const k = smoothstep(a[0], b[0], t);
      return out.set(lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k));
    }
  }
  const l = keys[keys.length - 1];
  return out.set(l[1], l[2], l[3]);
}

// Reload choreography: phase of the left hand and the magazine for progress u.
const rl = { phase: 'none', k: 0, pose: 0 };
function reloadPhase(W, u, empty) {
  const c = W.reloadCues;
  rl.pose = smoothstep(0, 0.12, u) * (1 - smoothstep(0.88, 1, u));
  const pouchAt = (c.magout + c.magin) * 0.5;
  if (u < c.magout) { rl.phase = 'reach'; rl.k = smoothstep(0.03, c.magout, u); }
  else if (u < c.magout + 0.1) { rl.phase = 'pull'; rl.k = (u - c.magout) / 0.1; }
  else if (u < pouchAt) { rl.phase = 'away'; rl.k = smoothstep(c.magout + 0.1, pouchAt, u); }
  else if (u < c.magin) { rl.phase = 'insert'; rl.k = smoothstep(pouchAt, c.magin, u); }
  else if (empty && u < Math.min(0.97, c.charge + 0.1)) { rl.phase = 'charge'; rl.k = clamp((u - c.magin) / Math.max(0.05, Math.min(0.97, c.charge + 0.1) - c.magin), 0, 1); }
  else { rl.phase = 'return'; rl.k = smoothstep(c.magin, Math.min(1, c.magin + 0.2), u); }
  return rl;
}

// ------------------------------------------------------------------------------------------ fire fx
function onLocalFire() {
  if (!cur || !visibleNow) return;
  flashT = 0;
  flash.rotation.set(0, 0, 0);
  flash.userData.roll = Math.random() * Math.PI * 2;
  flash.userData.scale = (cur.W.class === 'sniper' ? 1.3 : cur.pistol ? 0.7 : cur.W.class === 'smg' ? 0.8 : 1) * (0.85 + Math.random() * 0.3);
  // brass
  if (cur.W.mode !== 'bolt') ejectBrass(cur.pistol ? 0.45 : 0.6);
}

function ejectBrass(scale) {
  const C = casings;
  const c = C.list[C.next];
  C.next = (C.next + 1) % C.list.length;
  cur.casing.updateWorldMatrix(true, false);
  // into view space
  m1.copy(view.matrixWorld).invert().multiply(cur.casing.matrixWorld);
  c.p.setFromMatrixPosition(m1);
  // velocity in the weapon frame (the port node's own axes differ per model): out to the right, up, slightly forward
  cur.group.updateWorldMatrix(true, false);
  m2.copy(view.matrixWorld).invert().multiply(cur.group.matrixWorld);
  m2.extractRotation(m2);
  c.v.set(2.3 + Math.random() * 0.9, 0.9 + Math.random() * 0.6, -0.25 + Math.random() * 0.3).applyMatrix4(m2);
  // drawn at 60 % size: the eye is a hand span from the port, true-size brass reads as oversized on screen
  c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  c.rv.set((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 40);
  c.t = 0;
  c.s = scale;
}

const gView = new THREE.Vector3(), dummy = new THREE.Object3D();
function updateBrass(dt) {
  // gravity in view space
  gView.set(0, -9.81, 0).applyQuaternion(q1.copy(gfx.camera.quaternion).invert());
  let n = 0;
  for (const c of casings.list) {
    if (c.t > 0.7) continue;
    c.t += dt;
    c.v.addScaledVector(gView, dt);
    c.p.addScaledVector(c.v, dt);
    c.r.x += c.rv.x * dt; c.r.y += c.rv.y * dt; c.r.z += c.rv.z * dt;
    dummy.position.copy(c.p); dummy.rotation.copy(c.r); dummy.scale.setScalar(c.s || 1);
    dummy.updateMatrix();
    casings.mesh.setMatrixAt(n++, dummy.matrix);
  }
  casings.mesh.count = n;
  if (n) casings.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ per-frame
const acc = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
const camQ = new THREE.Quaternion(), camQInv = new THREE.Quaternion();
const sunDirV = new THREE.Vector3(), rayO = new THREE.Vector3(), camP = new THREE.Vector3(), pullEnd = new THREE.Vector3(), insStart = new THREE.Vector3();
export function update(dt) {
  if (!inited) return;
  const cam = gfx.camera;
  const me = localPlayer();
  const L = state.local;
  // Overlay camera mirrors the world camera; the viewmodel FOV follows only part of the ADS zoom.
  view.matrix.copy(cam.matrixWorld);
  view.matrixWorldNeedsUpdate = true;
  view.updateMatrixWorld(false);
  camP.setFromMatrixPosition(cam.matrixWorld);
  ovCam.position.setFromMatrixPosition(cam.matrixWorld);
  ovCam.quaternion.setFromRotationMatrix(m1.extractRotation(cam.matrixWorld));
  ovCam.aspect = cam.aspect;
  ovCam.updateMatrixWorld(true);

  const vs = weapons.viewState();
  const W = vs.drawn ? WEAPONS[vs.drawn] : null;
  const fp = L.mode === 'fp';
  const alive = me && me.alive && me.life === LIFE.GROUND;
  const scopedNow = !!(L.scoped && W && W.scope && alive);
  const show = externalVisible && fp && alive && !!W && !scopedNow && state.app === 'match';
  visibleNow = show;
  rigRoot.visible = show;
  // scope overlay (first and third person)
  updateScope(scopedNow && scopeEnabled);
  if (!show) {
    flash.visible = false; flashLight.intensity = 0; casings.mesh.count = 0; plateMesh.visible = false; fragMesh.visible = false;
    ovCam.fov = cam.fov; ovCam.updateProjectionMatrix();
    return;
  }
  equip(vs.drawn);
  const baseFov = cam.fov / Math.max(0.2, lerp(1, (W.adsFovMult || 1), L.ads));
  const vmFov = lerp(baseFov, cam.fov, TUNE.vmFovFollow * (W.scope ? 0.3 : 1));
  if (Math.abs(ovCam.fov - vmFov) > 1e-3) ovCam.fov = vmFov;
  ovCam.updateProjectionMatrix();

  // ---- lighting: sun direction from the world, dimmed when the eye is in shadow
  const sd = world.getSunDirection();
  sunDirV.set(sd[0], sd[1], sd[2]).normalize();
  if (--sunCheck <= 0) {
    sunCheck = TUNE.sunShadowEvery;
    rayO.setFromMatrixPosition(cam.matrixWorld);
    const h = world.raycast(rayO, sunDirV, 250);
    sunK = h ? 0.12 : 1;
  }
  sun.intensity = damp(sun.intensity, RENDER.sunIntensity * 0.8 * sunK, 6, dt);
  sun.position.setFromMatrixPosition(cam.matrixWorld).addScaledVector(sunDirV, 10);
  sun.target.position.setFromMatrixPosition(cam.matrixWorld);
  sun.target.updateMatrixWorld();

  // ---- springs and procedural inputs
  const ads = L.ads * L.ads * (3 - 2 * L.ads);
  const m = input.mouse();
  const sw = TUNE.sway;
  const swayTX = clamp(-m.dx * sw.perPx, -sw.max, sw.max) * (1 - 0.8 * ads);
  const swayTY = clamp(-m.dy * sw.perPx, -sw.max, sw.max) * (1 - 0.8 * ads);
  sway.vx += swayTX * 60 * Math.min(dt, 0.05); sway.vy += swayTY * 60 * Math.min(dt, 0.05);
  spring(sway, 'x', 'vx', 0, sw.k, sw.c, dt);
  spring(sway, 'y', 'vy', 0, sw.k, sw.c, dt);
  spring(kickS, 'z', 'vz', 0, TUNE.kick.k, TUNE.kick.c, dt);
  spring(kickS, 'p', 'vp', 0, TUNE.kick.k, TUNE.kick.c, dt);
  spring(kickS, 'r', 'vr', 0, TUNE.kick.k * 0.8, TUNE.kick.c, dt);
  spring(kickS, 'y', 'vy', 0, TUNE.kick.k * 0.8, TUNE.kick.c, dt);
  spring(land, 'y', 'v', 0, TUNE.land.k, TUNE.land.c, dt);
  breathT += dt * TUNE.breath.rate;
  // bob from the gait phase (synchronised with footsteps)
  const g = controller.gait();
  const speed = me.speed || 0;
  const grounded = controller.stanceInfo().grounded;
  const sprint = vs.sprint;
  const amp = (grounded ? clamp(speed / PLAYER.walkSpeed, 0, 1.6) : 0) * lerp(TUNE.bob.amp, TUNE.bob.sprintAmp, sprint) * lerp(1, TUNE.bob.adsMult, ads);
  const ph = g.phase * Math.PI * 2;
  bobX = damp(bobX, Math.sin(ph) * amp, 14, dt);
  bobY = damp(bobY, -Math.abs(Math.cos(ph)) * amp * 0.8, 14, dt);
  shotT += dt;
  flashT += dt;

  // ---- weapon pose in camera space
  const cls = cur.pistol ? TUNE.pose.pistol : TUNE.pose.rifle;
  // sight-centred base: hip <-> ADS
  const hp = cls.hip, hr = cls.hipRot;
  const bx = hp[0] * (1 - ads), by = hp[1] * (1 - ads), bz = hp[2] * (1 - ads);
  const brx = hr[0] * (1 - ads), bry = hr[1] * (1 - ads), brz = hr[2] * (1 - ads);
  const breath = Math.sin(breathT) * TUNE.breath.amp * (1 - 0.7 * ads);
  e1.set(brx + sway.y + breath * 0.5, bry + sway.x, brz + sway.x * 0.6, 'YXZ');
  q1.setFromEuler(e1);
  m1.compose(v1.set(bx + bobX + sway.x * -sw.posK * 0.1, by + bobY + breath + land.y, bz), q1, s1.set(1, 1, 1));
  if (TUNE.eye[cur.id]) cur.eye.fromArray(TUNE.eye[cur.id]);   // live-tunable (debug.combat.viewmodelTune)
  m2.makeTranslation(-cur.eye.x, -cur.eye.y, -cur.eye.z);
  m1.multiply(m2);                                   // M1: weapon origin (grip) in camera space
  // layered handling poses around the grip
  acc.px = acc.py = acc.pz = acc.rx = acc.ry = acc.rz = 0;
  addPose(acc, cls.sprint, sprint * (1 - ads));
  let reloadW = 0;
  if (vs.reload) { reloadPhase(WEAPONS[vs.reload.weapon], vs.reload.u, vs.reload.empty); reloadW = rl.pose; addPose(acc, cls.reload, reloadW); }
  let lowerW = 0;
  if (vs.switchPhase === 'lower') lowerW = smoothstep(0, 1, clamp(vs.switchT / Math.max(0.01, vs.switchDur), 0, 1));
  else if (vs.switchPhase === 'raise') lowerW = 1 - smoothstep(0, 1, clamp(vs.switchT / Math.max(0.01, vs.switchDur), 0, 1));
  addPose(acc, cls.lower, lowerW);
  const plateW = vs.plate ? smoothstep(0, 0.15, vs.plate.t) * (1 - smoothstep(PLAYER.armor.insertTime - 0.12, PLAYER.armor.insertTime, vs.plate.t)) : 0;
  addPose(acc, cls.plate, plateW);
  let nadeW = 0;
  if (vs.nade) nadeW = vs.nade.phase === 'cook' ? smoothstep(0, 0.18, vs.nade.t) : vs.nade.phase === 'throw' ? 1 - smoothstep(0.3, WEAPONS.frag.throwTime, vs.nade.t) * 0.4 : 0.6;
  addPose(acc, cls.nade, nadeW);
  addPose(acc, cls.swim, vs.swim ? 1 : 0);
  // M700 bolt cycle: roll the rifle a little while the bolt works
  let boltU = -1;
  if (vs.boltT >= 0) {
    boltU = clamp((vs.boltT / vs.boltDur - 0.14) / 0.8, 0, 1);
    const bw = Math.sin(Math.PI * boltU);
    acc.rz += 0.32 * bw; acc.rx += 0.06 * bw; acc.py -= 0.02 * bw;
  }
  // airborne: weapon floats up slightly
  if (!grounded) acc.py += 0.012;
  // recoil kick about the grip
  acc.pz += kickS.z; acc.rx += kickS.p; acc.rz += kickS.r; acc.ry += kickS.y;
  v2.setFromMatrixPosition(m1);                      // grip in camera space
  e1.set(acc.rx, acc.ry, acc.rz, 'YXZ');
  q2.setFromEuler(e1);
  m3.compose(v3.set(acc.px, acc.py, acc.pz).add(v2), q2, s1.set(1, 1, 1));
  m2.makeTranslation(-v2.x, -v2.y, -v2.z);
  m3.multiply(m2).multiply(m1);                      // final weapon pose in camera space

  // ---- place the rig (shoulders) from the base pose only, so handling layers do not swing the whole body into
  // view; the right arm then reaches the layered pose with IK and the hand takes the exact orientation
  mixer.update(dt);
  rigRoot.matrix.identity();
  rigRoot.updateMatrixWorld(true);
  mRigInv.copy(rigRoot.matrixWorld).invert();
  mSock.multiplyMatrices(mRigInv, bones.socket.matrixWorld);   // socket in rig space
  rigRoot.matrix.multiplyMatrices(m1, mSock.invert());
  rigRoot.matrixWorldNeedsUpdate = true;
  rigRoot.updateMatrixWorld(true);
  rightArm(m3);

  // ---- weapon parts: magazine, bolt / slide
  animateParts(vs, boltU);

  // ---- left hand
  leftHand(vs, reloadW, plateW, nadeW);

  // ---- fx
  updateFlash();
  updateBrass(dt);
}

const mTgt = new THREE.Matrix4(), mRel = new THREE.Matrix4(), rPos = new THREE.Vector3(), rQuat = new THREE.Quaternion(), rPole = new THREE.Vector3();
/** Right arm IK: put WeaponSocket_R (child of the right hand) on the camera-space pose m. */
function rightArm(m) {
  mTgt.multiplyMatrices(view.matrixWorld, m);                          // socket target, world
  mRel.copy(bones.rHand.matrixWorld).invert().multiply(bones.socket.matrixWorld);   // socket relative to the hand
  mTgt.multiply(mRel.invert());                                        // hand target, world
  mTgt.decompose(rPos, rQuat, s1);
  bones.rUpper.getWorldPosition(rPole);
  rPole.add(v4.set(0.8, -1.0, 0.2).applyQuaternion(gfx.camera.quaternion));
  ikTwoBone(bones.rUpper, bones.rFore, bones.rHand, rPos, rPole, 1);
  setBoneWorldQuat(bones.rHand, rQuat);
}

const boltOff = new THREE.Vector3();
function animateParts(vs, boltU) {
  const W = cur.W;
  // magazine
  if (cur.mag) {
    cur.mag.position.copy(cur.magPos);
    cur.mag.quaternion.copy(cur.magQuat);
    cur.mag.visible = true;
    // launcher: the warhead is gone once fired and comes back with the reload's insert
    const inv = state.local.inv, slot = inv && inv.slots ? inv.slots[inv.active] : null;
    if (W.class === 'launcher' && slot && slot.mag === 0) {
      const r = vs.reload && vs.reload.weapon === cur.id ? reloadPhase(W, vs.reload.u, vs.reload.empty) : null;
      cur.mag.visible = !!r && (r.phase === 'insert' || r.phase === 'charge' || r.phase === 'return');
    }
    if (vs.reload && vs.reload.weapon === cur.id) {
      const r = reloadPhase(W, vs.reload.u, vs.reload.empty);
      if (r.phase === 'pull') { cur.mag.position.y -= 0.24 * r.k * r.k; cur.mag.position.z += 0.03 * r.k; cur.mag.rotateX(-0.35 * r.k); }
      else if (r.phase === 'away') cur.mag.visible = true;
      else if (r.phase === 'insert') { const k = 1 - r.k; cur.mag.position.y -= 0.32 * k * k + 0.01; cur.mag.position.z += 0.05 * k; cur.mag.rotateX(-0.3 * k); }
    }
  }
  // bolt / slide
  if (cur.bolt) {
    cur.bolt.position.copy(cur.boltPos);
    cur.bolt.quaternion.copy(cur.boltQuat);
    const travel = TUNE.boltTravel[cur.id] || 0.05;
    let back = 0;
    if (W.mode !== 'bolt' && shotT < TUNE.shotCycle) back = Math.sin(Math.PI * shotT / TUNE.shotCycle) * travel * 0.9;
    if (cur.pistol && slideLock) back = travel;
    if (vs.reload && vs.reload.weapon === cur.id && vs.reload.empty) {
      const r = reloadPhase(W, vs.reload.u, true);
      if (cur.pistol && (r.phase === 'reach' || r.phase === 'pull' || r.phase === 'away' || r.phase === 'insert')) back = travel;
      if (r.phase === 'charge') back = Math.sin(Math.PI * clamp(r.k * 1.25, 0, 1)) * travel;
    }
    if (W.mode === 'bolt' && boltU >= 0) {
      // lift, pull, push, lower
      const lift = smoothstep(0, 0.2, boltU) * (1 - smoothstep(0.8, 1, boltU));
      const pull = smoothstep(0.2, 0.45, boltU) * (1 - smoothstep(0.55, 0.8, boltU));
      cur.bolt.rotateZ(-1.05 * lift);
      back = pull * travel;
    }
    if (back) { boltOff.set(0, 0, back); cur.bolt.position.add(boltOff); }
  }
}

const gripW = new THREE.Matrix4(), gripPos = new THREE.Vector3(), gripQuat = new THREE.Quaternion(), gripScale = new THREE.Vector3();
const handT = new THREE.Vector3(), pole = new THREE.Vector3(), magW = new THREE.Vector3();
function leftHand(vs, reloadW, plateW, nadeW) {
  const rel = cur.pistol ? gripRel.pistol : gripRel.rifle;
  bones.socket.updateWorldMatrix(true, false);
  gripW.multiplyMatrices(bones.socket.matrixWorld, rel);
  gripW.decompose(gripPos, gripQuat, gripScale);
  if (!cur.pistol) { v1.copy(cur.gripShift).applyQuaternion(q1.setFromRotationMatrix(m1.extractRotation(bones.socket.matrixWorld))); gripPos.add(v1); }
  handT.copy(gripPos);
  let weight = cur.pistol ? 0 : 1;
  plateMesh.visible = false;
  fragMesh.visible = false;
  // elbow pole: down and out to the left of the view
  camQ.copy(gfx.camera.quaternion);
  bones.lUpper.getWorldPosition(v4);
  pole.set(-0.7, -1.0, 0.25).applyQuaternion(camQ).add(v4);
  if (vs.reload && reloadW > 0) {
    const r = reloadPhase(cur.W, vs.reload.u, vs.reload.empty);
    if (cur.mag) { cur.mag.updateWorldMatrix(true, false); magW.setFromMatrixPosition(cur.mag.matrixWorld); }
    else magW.copy(gripPos);
    q1.setFromRotationMatrix(m1.extractRotation(bones.socket.matrixWorld));     // weapon orientation
    v2.set(0, -0.06, 0.01).applyQuaternion(q1);
    v3.copy(magW).add(v2);                           // palm under the magazine
    v4.set(-0.05, -0.42, -0.25).applyQuaternion(camQ).add(camP);    // off-screen low left (the pouch)
    pullEnd.set(0, -0.24, 0.03).applyQuaternion(q1).add(v3);
    insStart.set(0, -0.33, 0.05).applyQuaternion(q1).add(v3);
    switch (r.phase) {
      case 'reach': handT.lerpVectors(gripPos, v3, r.k); break;
      case 'pull': handT.copy(v3); break;
      case 'away':
        if (r.k < 0.5) handT.lerpVectors(pullEnd, v4, smoothstep(0, 0.5, r.k));
        else handT.lerpVectors(v4, insStart, smoothstep(0.5, 1, r.k));
        break;
      case 'insert': handT.copy(v3); break;
      case 'charge': {
        if (cur.bolt) { cur.bolt.updateWorldMatrix(true, false); v2.setFromMatrixPosition(cur.bolt.matrixWorld); } else v2.copy(gripPos);
        v2.add(v1.set(-0.045, -0.015, 0.03).applyQuaternion(camQ));
        handT.lerpVectors(v3, v2, Math.sin(Math.PI * clamp(r.k, 0, 1)));
        break;
      }
      default: handT.lerpVectors(v3, gripPos, r.k);
    }
    weight = 1;
  } else if (plateW > 0) {
    // down to the pouch, the plate rises into view lower left, lines up with the carrier, slammed home below
    const t = clamp(vs.plate.t / PLAYER.armor.insertTime, 0, 1);
    keyPath(TUNE.platePath, t, v2);
    const hw = smoothstep(0, 0.1, t) * (1 - smoothstep(0.86, 1, t));
    v2.applyQuaternion(camQ).add(camP);
    handT.lerpVectors(gripPos, v2, hw);
    weight = 1;
    plateMesh.visible = t > 0.15 && t < 0.8;
    if (plateMesh.visible) {
      keyPath(TUNE.platePath, t, v1);
      const H = TUNE.plateHold;
      plateMesh.position.set(v1.x + H[0], v1.y + H[1], v1.z + H[2]);
      const slam = smoothstep(0.62, 0.8, t), lift = smoothstep(0.15, 0.38, t);
      plateMesh.rotation.set(lerp(-1.25, -0.5, slam) + 0.25 * (1 - lift), 0.32 - 0.12 * slam, 0.14 + 0.2 * (1 - lift), 'YXZ');
    }
  } else if (nadeW > 0 && vs.nade) {
    const N = vs.nade;
    if (N.phase === 'cook') { keyPath(TUNE.throwPath, 0, v2); v2.y += Math.sin(N.t * 5) * 0.004; }
    else if (N.phase === 'throw') keyPath(TUNE.throwPath, N.t, v2);
    else v2.set(-0.05, -0.46, -0.3);
    v2.applyQuaternion(camQ).add(camP);
    const hw = N.phase === 'cook' ? smoothstep(0, 0.2, N.t) : N.phase === 'throw' ? 1 - smoothstep(0.4, WEAPONS.frag.throwTime, N.t) : 1 - smoothstep(0, 0.3, N.t);
    handT.lerpVectors(gripPos, v2, hw);
    weight = 1;
    fragMesh.visible = N.phase === 'cook' || (N.phase === 'throw' && !N.thrown);
  }
  if (weight > 0.01) {
    ikTwoBone(bones.lUpper, bones.lFore, bones.lHand, handT, pole, weight);
    // hand orientation: the baked handguard grip (relative to the weapon) on the gun, which also reads as a palm
    // cupping the magazine during a reload; the IK result elsewhere (pouch, plate, grenade)
    bones.lHand.getWorldQuaternion(qt);
    let ow = weight;
    if (vs.reload) ow = rl.phase === 'away' ? 0.35 : rl.phase === 'charge' ? 0.45 : 1;
    else if (plateW > 0 || nadeW > 0) ow = 0;
    if (ow > 0) { qt.slerp(gripQuat, ow); setBoneWorldQuat(bones.lHand, qt); }
    // the magazine travels with the hand between the well and the pouch (old one out, fresh one back)
    if (vs.reload && cur.mag && rl.phase === 'away') {
      bones.lHand.updateWorldMatrix(true, false);
      v1.setFromMatrixPosition(bones.lHand.matrixWorld);
      q1.setFromRotationMatrix(m1.extractRotation(bones.socket.matrixWorld));
      v1.add(v2.set(0, 0.07, -0.01).applyQuaternion(q1));
      cur.mag.parent.updateWorldMatrix(true, false);
      cur.mag.position.copy(cur.mag.parent.worldToLocal(v1));
      cur.mag.visible = rl.k < 0.42 || rl.k > 0.58;
    }
  }
  // props in the left hand (view space)
  if (fragMesh.visible) {
    bones.lHand.updateWorldMatrix(true, false);
    m2.copy(view.matrix).invert().multiply(bones.lHand.matrixWorld);
    m2.decompose(v1, q1, v2);
    if (fragMesh.visible) {
      fragMesh.position.copy(v1).add(v3.set(0.085, 0.02, -0.03).applyQuaternion(q1));
      fragMesh.quaternion.copy(q1);
      const pin = fragMesh.getObjectByName(WEAPONS.frag.model.pin);
      if (pin) pin.visible = !!(vs.nade && vs.nade.phase === 'cook' && vs.nade.t < 0.12);
    }
  }
}

function updateFlash() {
  const life = TUNE.flash.life;
  if (flashT < life) {
    cur.muzzle.updateWorldMatrix(true, false);
    m1.copy(view.matrix).invert().multiply(cur.muzzle.matrixWorld);
    m1.decompose(v1, q1, v2);
    const k = 1 - flashT / life;
    const s = (flash.userData.scale || 1) * (0.7 + 0.5 * k);
    flash.position.copy(v1);
    flash.quaternion.copy(q1);
    const front = flash.children[0];
    front.scale.setScalar(0.17 * s);
    front.rotation.z = flash.userData.roll || 0;
    flash.children[1].scale.setScalar(0.3 * s);
    flash.children[2].scale.setScalar(0.3 * s);
    flash.visible = true;
    flashLight.position.copy(v1);
    flashLight.intensity = TUNE.flash.light * k;
  } else { flash.visible = false; flashLight.intensity = 0; }
}

function updateScope(on) {
  const L = state.local;
  const target = on ? 1 : 0;
  const a = damp(scope.material.uniforms.uAlpha.value, target, on ? 30 : 18, 1 / 60);
  scope.material.uniforms.uAlpha.value = on ? Math.max(a, 0.6) : a;
  scope.visible = scope.material.uniforms.uAlpha.value > 0.01;
  if (!scope.visible) return;
  const cam = gfx.camera;
  const d = 0.05;
  const h = 2 * Math.tan(cam.fov * 0.5 * DEG) * d;
  scope.position.set(0, 0, -d);
  scope.scale.set(h * cam.aspect, h, 1);
  scope.material.uniforms.uAspect.value = cam.aspect;
  // sway (degrees) -> offset in units of half the screen height
  const sw = weapons.getSway();
  const t = Math.tan(cam.fov * 0.5 * DEG);
  scope.material.uniforms.uOffset.value.set(Math.tan(sw.yaw * DEG) / t, Math.tan(sw.pitch * DEG) / t);
  scope.material.uniforms.uBreath.value = L.breath;
}
