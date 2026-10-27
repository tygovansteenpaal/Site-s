// ZONEFALL - converts the extra Sketchfab models (~/Downloads) into game assets. Not part of the game; run once:
//   npm i @gltf-transform/core@4.2.1 @gltf-transform/functions@4.2.1 @gltf-transform/extensions@4.2.1 meshoptimizer sharp
//   node tools/build-models.mjs <source dir> <zonefall/assets>
// Outputs:
//   skins/batman.glb        static T-pose model auto-rigged here: a 20-joint ZF_* skeleton built from the soldier's
//                           bind pose (scaled to the model), vertex weights from distance to the bone segments
//   vehicles/plane.glb      toon plane (drop plane): rivets dropped, simplified; node 'ZF_prop' spins
//   vehicles/p1.glb         McLaren P1: nodes 'ZF_body' and 'ZF_wheel_lf|rf|lr|rr' (each wheel centred on its hub)
//   props/city/city.glb     Procedural City 3 at 0.85 scale: collider meshes carry the 'COL_' name prefix
//   props/city/city.json    building footprints [x0, z0, x1, z1, height] in city-local metres (after scaling)
import fs from 'fs';
import path from 'path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, simplify, weld, quantize, meshopt, flatten, join, clearNodeTransform, transformMesh } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [SRC = path.join(process.env.HOME, 'Downloads'), OUT = 'assets'] = process.argv.slice(2);
const io = () => new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const tris = (doc) => {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; }
  return Math.round(t);
};
async function finish(doc, file, { texSize = 1024, budget = 0, lockBorder = true, keepLeaves = false } = {}) {
  const before = tris(doc);
  await doc.transform(dedup(), prune({ keepLeaves }));
  if (budget && before > budget) await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: budget / before, error: 0.004, lockBorder }));
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality: 80 }), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune({ keepLeaves }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await io().write(file, doc);
  console.log(`${path.relative(OUT, file).padEnd(22)} tris ${before} -> ${tris(doc)}  ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
}
const bake = (doc) => { for (const n of doc.getRoot().listNodes()) if (n.getMesh()) clearNodeTransform(n); };
/** Make every mesh node a direct child of the scene with an identity transform (vertices in scene space). */
async function flat(doc) {
  await doc.transform(flatten());
  bake(doc);
  const scene = doc.getRoot().listScenes()[0];
  for (const n of doc.getRoot().listNodes()) if (n.getMesh() && n.getParentNode()) { n.getParentNode().removeChild(n); scene.addChild(n); }
  for (const n of doc.getRoot().listNodes()) if (!n.getMesh() && !n.listChildren().length && !n.getSkin()) n.dispose();
}

// ------------------------------------------------------------------------------------------ Batman auto-rig
const JOINTS = [
  // name, soldier bone, parent
  ['pelvis', 'Bip01 Pelvis', null], ['spine0', 'Bip01 Spine', 'pelvis'], ['spine1', 'Bip01 Spine1', 'spine0'], ['spine2', 'Bip01 Spine2', 'spine1'],
  ['neck', 'Bip01 Neck', 'spine2'], ['head', 'Bip01 Head', 'neck'],
  ['clav_l', 'Bip01 L Clavicle', 'spine2'], ['upper_l', 'Bip01 L UpperArm', 'clav_l'], ['fore_l', 'Bip01 L Forearm', 'upper_l'], ['hand_l', 'Bip01 L Hand', 'fore_l'],
  ['clav_r', 'Bip01 R Clavicle', 'spine2'], ['upper_r', 'Bip01 R UpperArm', 'clav_r'], ['fore_r', 'Bip01 R Forearm', 'upper_r'], ['hand_r', 'Bip01 R Hand', 'fore_r'],
  ['thigh_l', 'Bip01 L Thigh', 'pelvis'], ['calf_l', 'Bip01 L Calf', 'thigh_l'], ['foot_l', 'Bip01 L Foot', 'calf_l'],
  ['thigh_r', 'Bip01 R Thigh', 'pelvis'], ['calf_r', 'Bip01 R Calf', 'thigh_r'], ['foot_r', 'Bip01 R Foot', 'calf_r'],
];
// bone segments for weighting: [joint, end] (end: another joint, or an offset from the joint for end bones)
const SEGS = [
  ['pelvis', 'spine0'], ['spine0', 'spine1'], ['spine1', 'spine2'], ['spine2', 'neck'], ['neck', 'head'], ['head', [0, 0.24, 0.02]],
  ['clav_l', 'upper_l'], ['upper_l', 'fore_l'], ['fore_l', 'hand_l'], ['hand_l', [0.17, 0, 0]],
  ['clav_r', 'upper_r'], ['upper_r', 'fore_r'], ['fore_r', 'hand_r'], ['hand_r', [-0.17, 0, 0]],
  ['thigh_l', 'calf_l'], ['calf_l', 'foot_l'], ['foot_l', [0, -0.06, 0.16]],
  ['thigh_r', 'calf_r'], ['calf_r', 'foot_r'], ['foot_r', [0, -0.06, 0.16]],
];
const SPINE = new Set(['pelvis', 'spine0', 'spine1', 'spine2']);

function mat4Invert(m) {
  // affine 4x4 (column-major) inverse
  const [a, b, c, , d, e, f, , g, h, i, , x, y, z] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const id = 1 / det;
  const r = [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id, 0, (f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id, 0,
    (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id, 0, 0, 0, 0, 1];
  r[12] = -(r[0] * x + r[4] * y + r[8] * z); r[13] = -(r[1] * x + r[5] * y + r[9] * z); r[14] = -(r[2] * x + r[6] * y + r[10] * z);
  return r;
}

// Soldier bind pose in model space (bones + bounds), dumped by dev/skins.html?dump into tools/soldier-rest.json:
// the GLB's own mesh space is rotated and quantised, so the browser's posed skeleton is the reliable reference.
const soldierRest = () => JSON.parse(fs.readFileSync(new URL('./soldier-rest.json', import.meta.url)));
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

async function batman() {
  const S = soldierRest();
  const doc = await io().read(path.join(SRC, 'bruce_wayne_batman__arkham_city.glb'));
  await flat(doc);
  const root = doc.getRoot(), scene = root.listScenes()[0];
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const n of root.listNodes()) if (n.getMesh()) { const b = getBounds(n); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.min[k]); hi[k] = Math.max(hi[k], b.max[k]); } }
  // The model stands in a T-pose facing +Z (its left hand on +X). Soldier axes -> model axes: the soldier's
  // shoulder line becomes +X, up stays up, forward = right x up. Body joints are mapped and scaled by height;
  // the arm chains are laid out straight along +X from the shoulders so the hands land in the model's hands.
  const B = S.bones;
  const right = norm3(sub3(B['Bip01 L UpperArm'], B['Bip01 R UpperArm']));
  const up = norm3(sub3(sub3(B['Bip01 Neck'], B['Bip01 Pelvis']), right.map((v) => v * dot3(sub3(B['Bip01 Neck'], B['Bip01 Pelvis']), right))));
  const fwd = cross3(right, up);
  const c0 = [B['Bip01 Pelvis'][0], S.lo[1], B['Bip01 Pelvis'][2]];
  const k = (hi[1] - lo[1]) / (S.hi[1] - S.lo[1]);
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
  const map = (p) => { const d = sub3(p, c0); return [cx + dot3(d, right) * k, lo[1] + dot3(d, up) * k, cz + dot3(d, fwd) * k]; };
  const J = {};
  for (const [name, bone] of JOINTS) { if (!B[bone]) throw new Error('soldier bone missing: ' + bone); J[name] = map(B[bone]); }
  for (const s of ['l', 'r']) {
    const sg = s === 'l' ? 1 : -1, side = s === 'l' ? 'L' : 'R';
    const lu = Math.hypot(...sub3(B[`Bip01 ${side} Forearm`], B[`Bip01 ${side} UpperArm`]));
    const lf = Math.hypot(...sub3(B[`Bip01 ${side} Hand`], B[`Bip01 ${side} Forearm`]));
    const sh = J['upper_' + s];
    const tip = sg > 0 ? hi[0] : lo[0];
    const reach = Math.abs(tip - sh[0]) - 0.17 * k;          // shoulder -> wrist, leaving the hand bone to the fingertips
    const f = reach / (lu + lf);
    J['fore_' + s] = [sh[0] + sg * lu * f, sh[1], sh[2]];
    J['hand_' + s] = [sh[0] + sg * (lu + lf) * f, sh[1], sh[2]];
  }
  const ky = k;
  // joints: identity rotations, translations relative to the parent
  const nodes = {};
  for (const [name, , parent] of JOINTS) {
    const n = doc.createNode('ZF_' + name);
    const pp = parent ? J[parent] : [0, 0, 0];
    n.setTranslation([J[name][0] - pp[0], J[name][1] - pp[1], J[name][2] - pp[2]]);
    nodes[name] = n;
    (parent ? nodes[parent] : scene).addChild(n);
  }
  const order = JOINTS.map((j) => j[0]);
  const ibmArr = new Float32Array(order.length * 16);
  order.forEach((name, k) => { const p = J[name]; ibmArr.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], k * 16); });
  const buf = root.listBuffers()[0];
  const skin = doc.createSkin('batman').setSkeleton(nodes.pelvis)
    .setInverseBindMatrices(doc.createAccessor('ibm').setType('MAT4').setArray(ibmArr).setBuffer(buf));
  for (const name of order) skin.addJoint(nodes[name]);
  const segs = SEGS.map(([a, b]) => ({ j: order.indexOf(a), name: a, a: J[a], b: typeof b === 'string' ? J[b] : [J[a][0] + b[0] * ky, J[a][1] + b[1] * ky, J[a][2] + b[2] * ky] }));
  console.log('batman joints', Object.fromEntries(Object.entries(J).map(([n, p]) => [n, p.map((v) => +v.toFixed(2))])));
  const shoulderY = J.clav_l[1], backZ = J.spine1[2] - 0.1 * ky, hipY = J.pelvis[1];
  for (const n of root.listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    n.setSkin(skin);
    for (const prim of m.listPrimitives()) {
      const P = prim.getAttribute('POSITION'), cnt = P.getCount();
      const jo = new Uint8Array(cnt * 4), we = new Float32Array(cnt * 4), v = [0, 0, 0];
      for (let i = 0; i < cnt; i++) {
        P.getElement(i, v);
        const side = v[0] - cx;
        const cape = v[2] < backZ && v[1] < shoulderY && Math.abs(side) < (J.upper_l[0] - cx) * 1.1;
        const cand = [];
        for (const s of segs) {
          if (cape && !SPINE.has(s.name)) continue;            // the cape moves with the torso only
          if (s.name.endsWith('_l') && side < -0.04 * ky) continue;
          if (s.name.endsWith('_r') && side > 0.04 * ky) continue;
          if (/thigh|calf|foot/.test(s.name) && v[1] > hipY + 0.06 * ky) continue;
          cand.push([segDist(v, s.a, s.b), s.j]);
        }
        cand.sort((p, q) => p[0] - q[0]);
        const top = cand.slice(0, 3);
        let sum = 0;
        const w = top.map(([d]) => { const x = 1 / Math.pow(Math.max(d, 0.01 * ky), 4); sum += x; return x; });
        for (let k = 0; k < 4; k++) { jo[i * 4 + k] = k < top.length ? top[k][1] : 0; we[i * 4 + k] = k < top.length ? w[k] / sum : 0; }
      }
      prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(jo).setBuffer(buf));
      prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(we).setBuffer(buf));
    }
  }
  await finish(doc, path.join(OUT, 'skins/batman.glb'), { lockBorder: true });
}

// ------------------------------------------------------------------------------------------ plane
async function plane() {
  const doc = await io().read(path.join(SRC, 'toon_plane.glb'));
  await flat(doc);
  for (const n of doc.getRoot().listNodes()) {
    const nm = n.getName();
    if (/Rivet|Joystick|Seat_|cushion/i.test(nm)) { n.getMesh()?.dispose(); n.dispose(); }
    else if (/^Propeller/.test(nm)) n.setName('ZF_prop');
  }
  // the propeller spins about its own centre: move its pivot there
  const prop = doc.getRoot().listNodes().find((n) => n.getName() === 'ZF_prop');
  if (prop) {
    const b = getBounds(prop), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    transformMesh(prop.getMesh(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -c[1], -c[2], 1]);
    prop.setTranslation(c);
  }
  await finish(doc, path.join(OUT, 'vehicles/plane.glb'), { budget: 60000, texSize: 512 });
}

// ------------------------------------------------------------------------------------------ car
async function car() {
  const doc = await io().read(path.join(SRC, 'ac_-_mclaren_p1_free.glb'));
  const root = doc.getRoot(), scene = root.listScenes()[0];
  // which top-level wheel group a mesh node belongs to
  const parentOf = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const wheelOf = (n) => { for (let p = n; p; p = parentOf.get(p)) { const m = /^WHEEL_(LF|RF|LR|RR)$/.exec(p.getName()); if (m) return m[1].toLowerCase(); } return null; };
  const groups = { body: [], lf: [], rf: [], lr: [], rr: [] };
  for (const n of root.listNodes()) if (n.getMesh()) groups[wheelOf(n) || 'body'].push(n);
  await doc.transform(flatten());
  bake(doc);
  for (const [g, list] of Object.entries(groups)) {
    const holder = doc.createNode('ZF_' + (g === 'body' ? 'body' : 'wheel_' + g));
    scene.addChild(holder);
    for (const n of list) { n.getParentNode()?.removeChild(n); holder.addChild(n); }
  }
  for (const n of root.listNodes()) if (!n.getMesh() && !n.listChildren().length) n.dispose();
  for (const n of [...scene.listChildren()]) if (!n.getName().startsWith('ZF_')) { scene.removeChild(n); }
  await doc.transform(join({ keepNamed: true }), prune());
  // wheels: pivot on the hub centre
  for (const g of ['lf', 'rf', 'lr', 'rr']) {
    const h = root.listNodes().find((n) => n.getName() === 'ZF_wheel_' + g);
    const b = getBounds(h), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    for (const ch of h.listChildren()) if (ch.getMesh()) transformMesh(ch.getMesh(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -c[1], -c[2], 1]);
    h.setTranslation(c);
  }
  for (const m of root.listMaterials()) { const t = m.getExtension('KHR_materials_transmission'); if (t) { m.setExtension('KHR_materials_transmission', null); m.setAlphaMode('BLEND'); m.setAlpha(0.35); } }
  await finish(doc, path.join(OUT, 'vehicles/p1.glb'), { budget: 45000, texSize: 512 });
}

// ------------------------------------------------------------------------------------------ city
const CITY_SCALE = 0.85;
const COLLIDE = /facadesWalls|Brick_Wall|concrete|roof|CarTex|US_Doors|basic_metal|textured_metal/i;
const DROP = /DecalsStain|WetFloorSign|trash_can/i;

function footprints(doc) {
  // connected components of the wall meshes (vertices welded by position) -> axis-aligned rectangles
  const out = [];
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh();
    if (!m || !/facadesWalls|Brick_Wall|concrete/i.test(m.listPrimitives()[0]?.getMaterial()?.getName() || '')) continue;
    for (const p of m.listPrimitives()) {
      const P = p.getAttribute('POSITION'), I = p.getIndices(), cnt = P.getCount();
      const key = new Map(), par = new Int32Array(cnt).map((_, i) => i), v = [0, 0, 0];
      const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const pos = [];
      for (let i = 0; i < cnt; i++) {
        P.getElement(i, v); pos.push([...v]);
        const k = v.map((x) => Math.round(x * 20)).join(',');
        if (key.has(k)) par[find(i)] = find(key.get(k)); else key.set(k, i);
      }
      if (I) for (let t = 0; t < I.getCount(); t += 3) { const a = I.getScalar(t), b = I.getScalar(t + 1), c = I.getScalar(t + 2); par[find(b)] = find(a); par[find(c)] = find(a); }
      const box = new Map();
      for (let i = 0; i < cnt; i++) {
        const r = find(i), q = pos[i];
        const B = box.get(r) || [1e9, 1e9, -1e9, -1e9, 0];
        B[0] = Math.min(B[0], q[0]); B[1] = Math.min(B[1], q[2]); B[2] = Math.max(B[2], q[0]); B[3] = Math.max(B[3], q[2]); B[4] = Math.max(B[4], q[1]);
        box.set(r, B);
      }
      for (const B of box.values()) if (B[2] - B[0] > 4 && B[3] - B[1] > 4 && B[4] > 5) out.push(B.map((x) => +x.toFixed(2)));
    }
  }
  // merge overlapping rectangles (a building's walls and its brick base are separate components)
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5) {
        out[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4])];
        out.splice(j, 1); changed = true; break;
      }
    }
  }
  return out;
}

async function city() {
  const doc = await io().read(path.join(SRC, 'procedural_city_3.glb'));
  await flat(doc);
  const root = doc.getRoot();
  const s = CITY_SCALE;
  for (const n of root.listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const mat = m.listPrimitives()[0]?.getMaterial()?.getName() || '';
    if (DROP.test(mat)) { m.dispose(); n.dispose(); continue; }
    transformMesh(m, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
    n.setName((COLLIDE.test(mat) ? 'COL_' : '') + mat.replace(/[^A-Za-z0-9_]/g, '_'));
  }
  // centre the street plane on the origin
  let lo = [1e9, 1e9], hi = [-1e9, -1e9];
  for (const n of root.listNodes()) if (n.getMesh()) { const b = getBounds(n); lo = [Math.min(lo[0], b.min[0]), Math.min(lo[1], b.min[2])]; hi = [Math.max(hi[0], b.max[0]), Math.max(hi[1], b.max[2])]; }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  for (const n of root.listNodes()) if (n.getMesh()) transformMesh(n.getMesh(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], 0, -c[1], 1]);
  const fp = footprints(doc);
  fs.mkdirSync(path.join(OUT, 'props/city'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'props/city/city.json'), JSON.stringify({ size: [+(hi[0] - lo[0]).toFixed(2), +(hi[1] - lo[1]).toFixed(2)], buildings: fp }));
  console.log(`city: ${(hi[0] - lo[0]).toFixed(1)} x ${(hi[1] - lo[1]).toFixed(1)} m, ${fp.length} buildings`);
  // no simplification: at this scale even a small error collapses facade panels and cornices into holes
  await finish(doc, path.join(OUT, 'props/city/city.glb'), { texSize: 1024 });
}

// ------------------------------------------------------------------------------------------ RPG
// Source units ~780 long, warhead toward +Z, grips down (-Y). Game weapons: barrel along -Z, origin on the right
// hand (rear pistol grip), metres. Sockets as on the Stein weapons; the warhead is the 'MAGAZINE' (hidden once fired,
// back on reload). Points below are source coordinates read off a side render.
async function rpg() {
  const doc = await io().read(path.join(process.env.HOME, 'Desktop/3Models/fortnite_rpg.glb'));
  await flat(doc);
  const root = doc.getRoot(), scene = root.listScenes()[0];
  const s = 0.0016, A = [0, -70, -78];                 // rear grip top
  const T = (p) => [-(p[0] - A[0]) * s, (p[1] - A[1]) * s, -(p[2] - A[2]) * s];
  const M = [-s, 0, 0, 0, 0, s, 0, 0, 0, 0, -s, 0, A[0] * s, -A[1] * s, A[2] * s, 1];
  const body = doc.createNode('RPG'), mag = doc.createNode('MAGAZINE');
  scene.addChild(body); body.addChild(mag);
  for (const n of [...root.listNodes()]) {
    const m = n.getMesh();
    if (!m || n === body || n === mag) continue;
    transformMesh(m, M);
    n.getParentNode()?.removeChild(n);
    (/^Object_[35]$/.test(n.getName()) ? mag : body).addChild(n);
  }
  const sock = (name, p) => { const n = doc.createNode(name).setTranslation(T(p)); body.addChild(n); return n; };
  sock('SOCKET_FX_FIRE', [0, 0, 380]);                 // warhead tip: the rocket leaves from here
  sock('SOCKET_FX_BACKBLAST', [0, 0, -392]);
  sock('SOCKET_IRONSIGHT', [0, 87, 72]);                // front sight blade
  sock('SOCKET_ATTACH_SCOPE', [0, 99, -69]);            // rear sight
  sock('SOCKET_FX_CASING', [0, 0, -100]);
  sock('SLIDE', [0, 0, 0]);
  sock('SOCKET_ANCHOR', A);
  for (const n of [...scene.listChildren()]) if (n !== body) scene.removeChild(n);
  await finish(doc, path.join(OUT, 'weapons/sketchfab/rpg.glb'), { budget: 14000, texSize: 512, lockBorder: false, keepLeaves: true });
}

const jobs = { batman, plane, car, city, rpg };
await MeshoptEncoder.ready; await MeshoptDecoder.ready; await MeshoptSimplifier.ready;
for (const name of (process.argv[4] ? process.argv[4].split(',') : Object.keys(jobs))) await jobs[name]();
