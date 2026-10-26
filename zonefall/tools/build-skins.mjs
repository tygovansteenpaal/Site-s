// ZONEFALL - converts the character models in ~/Desktop/3Models into game skins (assets/skins/*.glb).
// Not part of the game; run once per new model:
//   npm i @gltf-transform/core@4.2.1 @gltf-transform/functions@4.2.1 @gltf-transform/extensions@4.2.1 meshoptimizer sharp
//   node tools/build-skins.mjs <source dir> assets/skins
// Per model: the bones the avatar retargeter needs are renamed to fixed ZF_* names (one pattern table per rig family:
// Unreal/Fortnite, Mixamo, SpongeBob), animations are dropped, textures go to 1024 px WebP, meshes above the triangle
// budget are simplified, and the result is quantised and meshopt-compressed like every other GLB in the game.
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress, simplify, weld, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

// id -> source file and rig family. Models without a skeleton cannot be animated and are not converted.
export const SKINS = {
  jonesy: { file: 'jonesy_fortnite.glb', rig: 'ue' },
  deadpool: { file: 'deadpool_fortnite_skin.glb', rig: 'ue' },
  stormtrooper: { file: 'pc_computer_-_fortnite_-_stormtrooper.glb', rig: 'ue' },
  banana: { file: 'banana_dancing_fortnite.glb', rig: 'ue' },
  daffy: { file: 'daffy_duck_-_fortnite_skin.glb', rig: 'ue' },
  drake: { file: 'fortnite_-_sgt._drake.glb', rig: 'ue' },
  bandit: { file: 'fortnite_psycho_bandit_from_borderlands.glb', rig: 'ue' },
  rigby: { file: 'rigby_-_fortnite_sidekick.glb', rig: 'ue' },
  lizard: { file: 'tom_lizard_fortnite_skin.glb', rig: 'ue' },
  huggy: { file: 'huggy_wuggyfortnite.glb', rig: 'mixamo' },
  spongebob: { file: 'spongebob_squarepants_fortnite.glb', rig: 'sponge' },
};

const TRI_BUDGET = 24000;
const TEX_SIZE = 1024;

// Canonical bone -> [pattern, parent canonical bone]. Patterns are tested against the lowercased source name with
// Sketchfab's numeric suffixes ("_04", "_126_11") still on, so they anchor on the start and allow trailing digits.
const S = '(_\\d+)*$';
const RIGS = {
  ue: {
    pelvis: [`^pelvis${S}`], spine0: [`^spine_01${S}`], spine1: [`^spine_03${S}`], spine2: [`^spine_05${S}`, `^spine_04${S}`],
    neck: [`^neck_01${S}`], head: [`^head${S}`],
    clav_l: [`^clavicle_l${S}`], upper_l: [`^upperarm_l${S}`], fore_l: [`^lowerarm_l${S}`], hand_l: [`^hand_l${S}`],
    clav_r: [`^clavicle_r${S}`], upper_r: [`^upperarm_r${S}`], fore_r: [`^lowerarm_r${S}`], hand_r: [`^hand_r${S}`],
    thigh_l: [`^thigh_l${S}`], calf_l: [`^calf_l${S}`], foot_l: [`^foot_l${S}`],
    thigh_r: [`^thigh_r${S}`], calf_r: [`^calf_r${S}`], foot_r: [`^foot_r${S}`],
  },
  mixamo: {
    pelvis: [`^mixamorig:hips${S}`], spine0: [`^mixamorig:spine${S}`], spine1: [`^mixamorig:spine1${S}`], spine2: [`^mixamorig:spine2${S}`],
    neck: [`^mixamorig:neck${S}`], head: [`^mixamorig:head${S}`],
    clav_l: [`^mixamorig:leftshoulder${S}`], upper_l: [`^mixamorig:leftarm${S}`], fore_l: [`^mixamorig:leftforearm${S}`], hand_l: [`^mixamorig:lefthand${S}`],
    clav_r: [`^mixamorig:rightshoulder${S}`], upper_r: [`^mixamorig:rightarm${S}`], fore_r: [`^mixamorig:rightforearm${S}`], hand_r: [`^mixamorig:righthand${S}`],
    thigh_l: [`^mixamorig:leftupleg${S}`], calf_l: [`^mixamorig:leftleg${S}`], foot_l: [`^mixamorig:leftfoot${S}`],
    thigh_r: [`^mixamorig:rightupleg${S}`], calf_r: [`^mixamorig:rightleg${S}`], foot_r: [`^mixamorig:rightfoot${S}`],
  },
  sponge: {
    pelvis: [`^root hips${S}`], spine0: [`^spine lower 01${S}`], spine1: [`^spine upper${S}`], spine2: [`^spine shoulders${S}`],
    neck: [`^head neck lower${S}`], head: [`^head adj${S}`],
    clav_l: [`^arm left shoulder 01${S}`], upper_l: [`^arm left shoulder 02${S}`], fore_l: [`^arm left elbow${S}`], hand_l: [`^arm left wrist${S}`],
    clav_r: [`^arm right shoulder 01${S}`], upper_r: [`^arm right shoulder 02${S}`], fore_r: [`^arm right elbow${S}`], hand_r: [`^arm right wrist${S}`],
    thigh_l: [`^leg left thigh${S}`], calf_l: [`^leg left knee${S}`], foot_l: [`^leg left ankle${S}`],
    thigh_r: [`^leg right thigh${S}`], calf_r: [`^leg right knee${S}`], foot_r: [`^leg right ankle${S}`],
  },
};

function renameBones(doc, rig) {
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) throw new Error('no skin');
  const joints = skin.listJoints();
  const parentOf = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c, n);
  const isUnder = (n, anc) => { for (let p = parentOf.get(n); p; p = parentOf.get(p)) if (p === anc) return true; return false; };
  const found = {};
  const missing = [];
  for (const [canon, pats] of Object.entries(RIGS[rig])) {
    let hit = null;
    for (const pat of pats) {
      const re = new RegExp(pat);
      const cands = joints.filter((j) => re.test(j.getName().toLowerCase()));
      // Several rigs carry duplicates (Drake has head_46 and Head_45): prefer the one under the pelvis, highest up.
      hit = cands.find((j) => !found.pelvis || isUnder(j, found.pelvis)) || cands[0] || null;
      if (hit) break;
    }
    if (hit) found[canon] = hit;
    else missing.push(canon);
  }
  if (missing.length) throw new Error('missing bones: ' + missing.join(', '));
  for (const [canon, node] of Object.entries(found)) node.setName('ZF_' + canon);
  return Object.keys(found).length;
}

function triangles(doc) {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices();
    t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  return Math.round(t);
}

async function main() {
  const [src = path.join(process.env.HOME, 'Desktop/3Models'), out = 'assets/skins'] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  for (const [id, def] of Object.entries(SKINS)) {
    const doc = await io.read(path.join(src, def.file));
    const bones = renameBones(doc, def.rig);
    for (const a of doc.getRoot().listAnimations()) a.dispose();
    const before = triangles(doc);
    await doc.transform(dedup(), prune(), resample());
    if (before > TRI_BUDGET) {
      await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: TRI_BUDGET / before, error: 0.002, lockBorder: true }));
    }
    await doc.transform(
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEX_SIZE, TEX_SIZE], quality: 82 }),
      quantize(),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
      prune(),
    );
    const file = path.join(out, id + '.glb');
    await io.write(file, doc);
    console.log(`${id.padEnd(13)} bones ${bones}  tris ${before} -> ${triangles(doc)}  ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
