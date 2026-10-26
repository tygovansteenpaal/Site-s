// ZONEFALL - character skins on top of the soldier rig. OWNER: PLAYER (internal to avatar.js).
//
// The soldier skeleton stays the single source of motion: the mixer, the aim solver, hand IK, reloads and the chute
// arms all keep driving the Bip01 bones exactly as before, and the soldier's meshes are simply hidden. A skin is a
// second skinned model (assets/skins/<id>.glb) whose 20 key bones were renamed to ZF_* by tools/build-skins.mjs.
// After the procedural pass every frame, each ZF bone copies the world-space rotation its soldier bone made since
// the rest pose:
//
//   dstWorld = srcWorld * inverse(srcRest) * C * dstRest
//
// srcRest and dstRest are both bind poses (the soldier is in a T-pose, most skins in an A-pose). C turns the skin's
// rest limb direction onto the soldier's (arms and legs only), so an A-pose arm is lifted to the T-pose first and
// then follows the animation. Bones between the mapped ones (twist bones, extra spine and neck joints, fingers,
// cloth and hair) keep their rest pose relative to their parent. The pelvis also follows the soldier's hip
// translation, scaled by the ratio of hip heights so short-legged skins do not float or sink.
//
// Alignment: the skin is turned so its shoulders and spine match the soldier's axes, scaled to the soldier's
// standing height (same hitboxes for everyone) and dropped so the lowest foot rests on the ground.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// canonical bone -> soldier bone
const MAP = {
  pelvis: 'Bip01_Pelvis', spine0: 'Bip01_Spine', spine1: 'Bip01_Spine1', spine2: 'Bip01_Spine2',
  neck: 'Bip01_Neck', head: 'Bip01_Head',
  clav_l: 'Bip01_L_Clavicle', upper_l: 'Bip01_L_UpperArm', fore_l: 'Bip01_L_Forearm', hand_l: 'Bip01_L_Hand',
  clav_r: 'Bip01_R_Clavicle', upper_r: 'Bip01_R_UpperArm', fore_r: 'Bip01_R_Forearm', hand_r: 'Bip01_R_Hand',
  thigh_l: 'Bip01_L_Thigh', calf_l: 'Bip01_L_Calf', foot_l: 'Bip01_L_Foot',
  thigh_r: 'Bip01_R_Thigh', calf_r: 'Bip01_R_Calf', foot_r: 'Bip01_R_Foot',
};
// limb bones whose rest direction is corrected (bone -> child it points at); end bones borrow their parent's C
const AIM = {
  clav_l: 'upper_l', upper_l: 'fore_l', fore_l: 'hand_l', clav_r: 'upper_r', upper_r: 'fore_r', fore_r: 'hand_r',
  thigh_l: 'calf_l', calf_l: 'foot_l', thigh_r: 'calf_r', calf_r: 'foot_r',
};
const BORROW = { hand_l: 'fore_l', hand_r: 'fore_r', foot_l: 'calf_l', foot_r: 'calf_r' };
const ARM_ROOTS = ['ZF_fore_l', 'ZF_fore_r'];   // these bones and everything under them count as "arms" in ADS

const restCache = new Map();   // soldier model key -> rest {q, p} per canonical bone, in model space

const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _qri = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4(), _rootInv = new THREE.Matrix4();

// Soldier only: posed from its inverse bind matrices. Skins keep their node transforms as exported: SpongeBob's
// inverse binds live in another space than its node tree, and skeleton.pose() turns him upside down.
function bindPose(root) {
  const seen = new Set();
  root.traverse((o) => { if (o.isSkinnedMesh && !seen.has(o.skeleton)) { seen.add(o.skeleton); o.skeleton.pose(); } });
  root.updateMatrixWorld(true);
}

function restOf(root, names) {
  const out = {};
  for (const [canon, name] of Object.entries(names)) {
    const b = root.getObjectByName(name);
    if (!b) throw new Error(`[PLAYER/skin] bone '${name}' missing`);
    const q = new THREE.Quaternion(), p = new THREE.Vector3();
    b.matrixWorld.decompose(p, q, _s);
    out[canon] = { q, p, bone: b };
  }
  return out;
}

const heightCache = new Map();
function soldierHeight(modelKey, cloneSoldier) {
  let h = heightCache.get(modelKey);
  if (h == null) {
    const probe = cloneSoldier(modelKey);
    bindPose(probe);
    const b = new THREE.Box3().setFromObject(probe);
    h = b.max.y - b.min.y;
    heightCache.set(modelKey, h);
  }
  return h;
}

/** Soldier rest pose per model key, from a throwaway clone. */
function soldierRest(modelKey, cloneSoldier) {
  let r = restCache.get(modelKey);
  if (r) return r;
  const probe = cloneSoldier(modelKey);
  bindPose(probe);
  r = restOf(probe, MAP);
  for (const k of Object.keys(r)) delete r[k].bone;
  restCache.set(modelKey, r);
  return r;
}

function basis(rest) {
  const right = _v.subVectors(rest.upper_l.p, rest.upper_r.p).normalize().clone();
  const up = _v2.subVectors(rest.neck.p, rest.pelvis.p);
  up.addScaledVector(right, -up.dot(right)).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, up);
  return new THREE.Matrix4().makeBasis(right, up, fwd);
}

/**
 * Build a skin instance for an avatar.
 * @param {object} gltf          loaded skin (shared; cloned here)
 * @param {string} modelKey      the avatar's soldier model key (soldier_a | soldier_b)
 * @param {(key:string) => THREE.Object3D} cloneSoldier
 * @returns {{group: THREE.Group, meshes: THREE.Mesh[], bones: object, isArm: (bone) => boolean}}
 */
export function createSkin(gltf, modelKey, cloneSoldier) {
  const src = soldierRest(modelKey, cloneSoldier);
  const model = SkeletonUtils.clone(gltf.scene);
  model.updateMatrixWorld(true);   // the node transforms as exported are the rest pose (see note at bindPose)
  const raw = restOf(model, Object.fromEntries(Object.keys(MAP).map((k) => [k, 'ZF_' + k])));

  // orientation: skin axes -> soldier axes
  const A = new THREE.Matrix4().multiplyMatrices(basis(src), basis(raw).transpose());
  const Aq = new THREE.Quaternion().setFromRotationMatrix(A);
  // size and ground: from the meshes' bind-pose bounds (head bones sit anywhere: SpongeBob's and Banana's are mid-body)
  const group = new THREE.Group();
  group.name = 'skin';
  group.quaternion.copy(Aq);
  group.add(model);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const k = soldierHeight(modelKey, cloneSoldier) / Math.max(1e-3, box.max.y - box.min.y);
  group.scale.setScalar(k);
  const pel = raw.pelvis.p.clone().applyQuaternion(Aq).multiplyScalar(k);
  group.position.set(src.pelvis.p.x - pel.x, -box.min.y * k, src.pelvis.p.z - pel.z);
  group.updateMatrixWorld(true);

  // per bone: dst rest in model space and the correction C
  const bones = [];
  const dstRest = {};
  for (const canon of Object.keys(MAP)) {
    const b = raw[canon].bone;
    const q = new THREE.Quaternion(), p = new THREE.Vector3();
    b.matrixWorld.decompose(p, q, _s);
    dstRest[canon] = { q, p };
  }
  const C = {};
  for (const [canon, child] of Object.entries(AIM)) {
    const dDir = _v.subVectors(dstRest[child].p, dstRest[canon].p).normalize().clone();
    const sDir = _v2.subVectors(src[child].p, src[canon].p).normalize();
    C[canon] = new THREE.Quaternion().setFromUnitVectors(dDir, sDir);
  }
  for (const [canon, from] of Object.entries(BORROW)) C[canon] = C[from];
  for (const canon of Object.keys(MAP)) {
    const c = C[canon] || new THREE.Quaternion();
    // offset = inverse(srcRest) * C * dstRest, so dstWorld = srcWorld * offset
    const offset = src[canon].q.clone().invert().multiply(c).multiply(dstRest[canon].q);
    let depth = 0;
    for (let o = raw[canon].bone; o; o = o.parent) depth++;
    bones.push({ canon, dst: raw[canon].bone, srcName: MAP[canon], offset, depth });
  }
  bones.sort((a, b) => a.depth - b.depth);
  const hip = {
    srcRest: src.pelvis.p.clone(), dstRest: dstRest.pelvis.p.clone(),
    ratio: dstRest.pelvis.p.y / Math.max(1e-3, src.pelvis.p.y),
  };

  const meshes = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if (o.isSkinnedMesh) { o.computeBoundingSphere(); o.boundingSphere.radius *= 1.8; }
    meshes.push(o);
  });
  const armSet = new Set();
  for (const n of ARM_ROOTS) { const b = model.getObjectByName(n); if (b) b.traverse((o) => armSet.add(o)); }
  return { group, model, meshes, bones, hip, isArm: (bone) => armSet.has(bone), srcBones: null };
}

/** Copy the soldier's pose onto the skin. Call after the soldier skeleton is final for this frame. */
export function retarget(skin, avRoot, soldierModel) {
  if (!skin.srcBones) skin.srcBones = skin.bones.map((b) => soldierModel.getObjectByName(b.srcName));
  avRoot.updateMatrixWorld(true);
  _rootInv.copy(avRoot.matrixWorld).invert();
  avRoot.matrixWorld.decompose(_v, _qr, _s);
  _qri.copy(_qr).invert();
  for (let i = 0; i < skin.bones.length; i++) {
    const b = skin.bones[i];
    const s = skin.srcBones[i];
    const parent = b.dst.parent;
    parent.updateWorldMatrix(true, false);
    // target world rotation: root * (soldier rotation in root space) * offset
    s.matrixWorld.decompose(_v, _q, _s);
    _q.premultiply(_qri).multiply(b.offset).premultiply(_qr);
    parent.matrixWorld.decompose(_v, _qp, _s);
    b.dst.quaternion.copy(_qp.invert().multiply(_q));
    if (b.canon === 'pelvis') {
      _v.setFromMatrixPosition(s.matrixWorld).applyMatrix4(_rootInv);          // soldier hips, root space
      _v.sub(skin.hip.srcRest).multiplyScalar(skin.hip.ratio).add(skin.hip.dstRest);
      _v.applyMatrix4(avRoot.matrixWorld);
      b.dst.position.copy(_v.applyMatrix4(_m.copy(parent.matrixWorld).invert()));
    }
    b.dst.updateWorldMatrix(false, false);
  }
}
