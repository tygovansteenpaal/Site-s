// ZONEFALL - trees, bushes, rocks and grass. OWNER: WORLD (internal).
// Trees: a handful of species are grown at load with ez-tree (MIT, dynamic import), re-materialised as PBR with
// crown-shaped leaf normals and vertex wind, and drawn as InstancedMeshes in three LODs: the full tree near the
// camera, a lighter tree (meshopt-simplified bark, every other leaf card enlarged) further out, and camera-facing
// impostors beyond quality.treeLodDistance, baked at load from 8 directions under the real sun and sky. The tree
// set (positions, trunk colliders) is identical on every tier so bullets and movement agree between peers;
// quality.foliage scales bushes, and grass density/radius follow quality.grass.
// Rocks are noise-deformed icosahedrons in the rock texture with triangle colliders.
import * as THREE from 'three';
import { MAP, ALL_SITES, FORESTS } from '../core/mapdata.js';
import { SURFACE, RENDER } from '../config.js';
import { Rng, mixSeed, hashString } from '../core/rng.js';
import { gfx } from '../core/state.js';
import { heightAt, normalAt, forestAt, nearestRoad, paintAt, sandiness, quarry } from './heightfield.js';
import { L, getArrays, surfaceMaterial, noiseTexture } from './materials.js';
import { corners } from './layout.js';
import { sunVector, shadowExtent } from './sky.js';

const SIMPLIFIER_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';

const TUNE = {
  forestTrees: 1050, sparseTrees: 260,
  bushes: 650,
  rocks: 300,
  nearFrac: 0.22,               // LOD0 radius as a fraction of quality.treeLodDistance ...
  nearMin: 26, nearMax: 48,     // ... clamped to this range (m)
  shadowPad: 1.0,              // LOD1 trees cast shadows within this multiple of the shadow box half extent
  rockCull: 1.15,               // rocks drawn within quality.propDistance x this
  impostorFrame: [128, 256],
  update: 0.2,
  grassTile: 8,
  grassRadius: { 0.5: 26, 1: 40 },
  grassBudgetMs: 3,             // new grass tiles generated per frame, by time
  grassSpacing: 0.58,
  windSpeed: 1.0,
};

// Species: preset, real height (m), leaf colour tint, weight in forests / countryside
const SPECIES = [
  { preset: 'Pine Medium', seed: 11, height: 19, forest: 0.34, open: 0.05, tune: { seg: 0.6, sec: 0.7, leaves: 0.42, leafSize: 1.42 } },
  { preset: 'Pine Large', seed: 23, height: 23, forest: 0.24, open: 0.05, tune: { seg: 0.6, sec: 0.6, leaves: 0.42, leafSize: 1.42 } },
  { preset: 'Oak Medium', seed: 37, height: 15, forest: 0.18, open: 0.42, tune: { seg: 0.7, sec: 0.8, leaves: 0.34, leafSize: 1.5 } },
  { preset: 'Ash Small', seed: 41, height: 14, forest: 0.14, open: 0.3, tune: { seg: 0.7, sec: 0.7, leaves: 0.36, leafSize: 1.45 } },
  { preset: 'Aspen Medium', seed: 53, height: 17, forest: 0.1, open: 0.18, tint: 0x9fb45c, tune: { seg: 0.8, sec: 0.8, leaves: 0.62, leafSize: 1.25 } },
];
const BUSH = { preset: 'Bush 2', seed: 71, height: 2.2, tint: 0x6d8a3c, tune: { seg: 0.6, sec: 0.6, leaves: 1.15, leafSize: 1.45 } };

let root = null;
let simplifier = null;
let variants = [];          // per species: {lod0:{bark, leaves}, lod1:{bark, leaves}, h, r, trunkR, frame}
let trees = [];             // {x, y, z, yaw, s, v}
let treeMeshes = [];        // per variant: {l0b, l0l, l1b, l1l}
let impostor = null;        // {mesh, attrVariant, atlas}
let bushes = [], bushMesh = null, hedges = [];
let rocks = [], rockMeshes = [];
let grass = null;
let windUniform = { value: 0 };
let qual = null;
let acc = 1;
const lastView = new THREE.Vector3(1e9, 0, 0);
const stats = { trees: 0, near: 0, mid: 0, far: 0, bushes: 0, grass: 0, rocks: 0 };

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------------------------------ helpers
function waitTexture(tex) {
  return new Promise((resolve) => {
    if (!tex) return resolve();
    const img = tex.image;
    if (img && (img.complete || img.width)) return resolve();
    const t0 = performance.now();
    const poll = () => {
      const im = tex.image;
      if ((im && (im.complete || im.width > 0)) || performance.now() - t0 > 8000) resolve(); else setTimeout(poll, 30);
    };
    poll();
  });
}

function simplifyIndex(geo, ratio, err = 0.02) {
  if (!simplifier) return null;
  const idx = geo.index.array instanceof Uint32Array ? geo.index.array : Uint32Array.from(geo.index.array);
  const target = Math.max(36, Math.floor((idx.length * ratio) / 3) * 3);
  try {
    const [out] = simplifier.simplify(idx, geo.attributes.position.array, 3, target, err, []);
    if (!out || out.length < 12) return null;
    const g = new THREE.BufferGeometry();
    for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.attributes[k]);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
    return g;
  } catch (e) { return null; }
}

/** Scale a tree geometry to real metres and add a wind weight attribute (0 at the base, 1 at the top). */
function prepare(geo, scale, height) {
  const g = geo.clone();
  g.scale(scale, scale, scale);
  const p = g.attributes.position;
  const w = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) w[i] = Math.pow(Math.max(0, p.getY(i)) / height, 1.6);
  g.setAttribute('aWind', new THREE.BufferAttribute(w, 1));
  if (!g.index) g.setIndex([...Array(p.count).keys()]);
  return g;
}

/** Leaf normals bent toward a sphere around the crown centre for soft, volumetric canopy light. */
function crownNormals(g) {
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  const p = g.attributes.position, n = g.attributes.normal;
  const v = new THREE.Vector3(), o = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).sub(c).normalize();
    o.fromBufferAttribute(n, i);
    v.lerp(o, 0.25).normalize();
    v.y = v.y * 0.8 + 0.2;
    v.normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  n.needsUpdate = true;
}

/** Keep every other leaf card (4 vertices each) and enlarge it about its centre: same silhouette, half the cost. */
function thinLeaves(g, keepEvery = 2, grow = 1.45) {
  const idx = g.index.array;
  const quads = idx.length / 6;
  const out = [];
  const p = g.attributes.position;
  const pos = new Float32Array(p.array);
  for (let q = 0; q < quads; q++) {
    if (q % keepEvery !== 0) continue;
    const ids = [idx[q * 6], idx[q * 6 + 1], idx[q * 6 + 2], idx[q * 6 + 5]];
    let cx = 0, cy = 0, cz = 0;
    for (const i of ids) { cx += p.getX(i); cy += p.getY(i); cz += p.getZ(i); }
    cx /= 4; cy /= 4; cz /= 4;
    for (const i of ids) {
      pos[i * 3] = cx + (p.getX(i) - cx) * grow; pos[i * 3 + 1] = cy + (p.getY(i) - cy) * grow; pos[i * 3 + 2] = cz + (p.getZ(i) - cz) * grow;
    }
    for (let k = 0; k < 6; k++) out.push(idx[q * 6 + k]);
  }
  const h = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) h.setAttribute(k, k === 'position' ? new THREE.BufferAttribute(pos, 3) : g.attributes[k]);
  h.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
  return h;
}

const WIND_VERT = /* glsl */`
  vec3 zfIp = vec3( 0.0 );
  #ifdef USE_INSTANCING
    zfIp = instanceMatrix[ 3 ].xyz;
  #endif
  float zfPh = dot( zfIp.xz, vec2( 0.071, 0.053 ) );
  float zfW = aWind * uWindAmp;
  transformed.x += ( sin( uWindTime * 1.3 + zfPh ) * 0.6 + sin( uWindTime * 2.9 + zfPh * 1.7 + position.y * 0.3 ) * 0.25 ) * zfW;
  transformed.z += ( cos( uWindTime * 1.1 + zfPh * 1.3 ) * 0.45 + sin( uWindTime * 3.4 + position.x * 0.5 ) * 0.2 ) * zfW;
`;

function windMaterial(base, amp, kind) {
  base.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = windUniform;
    sh.uniforms.uWindAmp = { value: amp };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWind;\nuniform float uWindTime;\nuniform float uWindAmp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERT);
    if (kind === 'leaves') {
      // crown normals light both faces of a card alike (no back-face flip), and a little light through the leaves
      // keeps shaded canopy from going black
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );\nnonPerturbedNormal = normal;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.07;');
    }
  };
  base.customProgramCacheKey = () => `zf-wind-${kind}-${amp}`;
  return base;
}

// ------------------------------------------------------------------------------------------ species generation
async function grow(Tree, sp) {
  const t = new Tree();
  t.loadPreset(sp.preset);
  const o = t.options;
  o.seed = sp.seed;
  for (const k of Object.keys(o.branch.segments)) o.branch.segments[k] = Math.max(3, Math.round(o.branch.segments[k] * sp.tune.seg));
  for (const k of Object.keys(o.branch.sections)) o.branch.sections[k] = Math.max(3, Math.round(o.branch.sections[k] * sp.tune.sec));
  o.leaves.count = Math.max(2, Math.round(o.leaves.count * sp.tune.leaves));
  o.leaves.size *= sp.tune.leafSize;
  t.generate();
  const bm = t.branchesMesh, lm = t.leavesMesh;
  await Promise.all([waitTexture(bm.material.map), waitTexture(bm.material.normalMap), waitTexture(lm.material.map)]);
  bm.geometry.computeBoundingBox();
  lm.geometry.computeBoundingBox();
  const rawH = Math.max(bm.geometry.boundingBox.max.y, lm.geometry.boundingBox.max.y);
  const scale = sp.height / rawH;
  const bark = prepare(bm.geometry, scale, sp.height);
  const leaves = prepare(lm.geometry, scale, sp.height);
  crownNormals(leaves);
  // trunk radius near the ground
  let tr = 0.15;
  const p = bark.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0.6) tr = Math.max(tr, Math.hypot(p.getX(i), p.getZ(i)));
  const box = new THREE.Box3().setFromBufferAttribute(leaves.attributes.position).union(new THREE.Box3().setFromBufferAttribute(bark.attributes.position));
  const radius = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  const barkMat = windMaterial(new THREE.MeshStandardMaterial({
    name: `bark-${sp.preset}`, map: bm.material.map, normalMap: bm.material.normalMap || null, color: 0xffffff,
    roughness: 0.92, metalness: 0, normalScale: new THREE.Vector2(1.2, 1.2),
  }), 0.06, 'bark');
  const leafMat = windMaterial(new THREE.MeshStandardMaterial({
    name: `leaves-${sp.preset}`, map: lm.material.map, color: sp.tint != null ? new THREE.Color(sp.tint) : lm.material.color.clone().multiplyScalar(0.92),
    roughness: 0.78, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5,
  }), 0.16, 'leaves');
  const bark0 = simplifyIndex(bark, 0.55, 0.006) || bark;
  const bark1 = simplifyIndex(bark, 0.24) || bark0;
  const leaves1 = thinLeaves(leaves, 3, 1.62);
  return { sp, h: sp.height, radius, trunkR: Math.min(0.55, tr * 0.85), box, barkMat, leafMat, lod0: { bark: bark0, leaves }, lod1: { bark: bark1, leaves: leaves1 },
    tris0: (bark0.index.count + leaves.index.count) / 3, tris1: (bark1.index.count + leaves1.index.count) / 3 };
}

// ------------------------------------------------------------------------------------------ impostors
const IMP_VERT = /* glsl */`
attribute float aVariant;
uniform vec4 uDims[ 8 ];        // width, height, base offset, row
uniform float uRows;
varying vec2 vUv;
varying float vRow;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec3 centre = instanceMatrix[ 3 ].xyz;
  float s = length( instanceMatrix[ 0 ].xyz );
  float yaw = atan( instanceMatrix[ 0 ].z, instanceMatrix[ 0 ].x );
  vec4 dm = uDims[ int( aVariant + 0.5 ) ];
  vec3 toCam = cameraPosition - centre;
  vec2 tc = normalize( toCam.xz + vec2( 1e-4 ) );
  vec3 right = vec3( tc.y, 0.0, -tc.x );
  float az = atan( tc.x, tc.y ) + yaw;
  float fr = mod( floor( az / ( PI2 / 8.0 ) + 0.5 ), 8.0 );
  vec3 wp = centre + right * ( uv.x - 0.5 ) * dm.x * s + vec3( 0.0, 1.0, 0.0 ) * ( uv.y * dm.y + dm.z ) * s;
  vUv = vec2( ( fr + uv.x ) / 8.0, ( dm.w + uv.y ) / uRows );
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const IMP_FRAG = /* glsl */`
uniform sampler2D tAtlas;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 c = texture2D( tAtlas, vUv );
  if ( c.a < 0.42 ) discard;
  gl_FragColor = vec4( c.rgb, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function bakeImpostors(scene) {
  const renderer = gfx.renderer;
  const [fw, fh] = TUNE.impostorFrame;
  const rows = variants.length;
  const rt = new THREE.WebGLRenderTarget(fw * 8, fh * rows, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true });
  rt.texture.generateMipmaps = true;
  rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  const bake = new THREE.Scene();
  bake.environment = scene.environment;
  bake.environmentIntensity = scene.environmentIntensity;
  const sun = new THREE.DirectionalLight(0xfff1de, RENDER.sunIntensity);
  const sd = sunVector();
  bake.add(sun, sun.target);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear };
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x1d2618, 0);
  renderer.clear(true, true, true);
  renderer.autoClear = false;
  const dims = [];
  variants.forEach((v, row) => {
    const width = v.radius * 2.1, height = v.box.max.y - Math.min(0, v.box.min.y) + 0.4;
    dims.push(new THREE.Vector4(width, height, Math.min(0, v.box.min.y) - 0.2, row));
    const grp = new THREE.Group();
    const b = new THREE.Mesh(v.lod0.bark, v.barkMat), l = new THREE.Mesh(v.lod0.leaves, v.leafMat);
    grp.add(b, l);
    bake.add(grp);
    for (let f = 0; f < 8; f++) {
      const az = (f / 8) * Math.PI * 2;
      // camera looks at the tree from azimuth az (matches the shader's frame selection)
      const dist = 100;
      cam.left = -width / 2; cam.right = width / 2; cam.top = height; cam.bottom = 0;
      cam.position.set(Math.sin(az) * dist, Math.min(0, v.box.min.y) - 0.2, Math.cos(az) * dist);
      cam.lookAt(0, Math.min(0, v.box.min.y) - 0.2, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      sun.position.copy(sd).multiplyScalar(80);
      sun.target.position.set(0, 0, 0);
      sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
      rt.viewport.set(f * fw, row * fh, fw, fh);
      rt.scissor.set(f * fw, row * fh, fw, fh);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.render(bake, cam);
    }
    bake.remove(grp);
  });
  rt.scissorTest = false;
  rt.viewport.set(0, 0, fw * 8, fh * rows);
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.alpha);
  renderer.autoClear = prev.autoClear;
  // impostor material: a camera-facing quad per tree, frame picked by view azimuth relative to the tree yaw
  const mat = new THREE.ShaderMaterial({
    name: 'zf-impostor', vertexShader: IMP_VERT, fragmentShader: IMP_FRAG, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tAtlas: { value: null }, uDims: { value: [] }, uRows: { value: rows } }]),
  });
  mat.uniforms.tAtlas.value = rt.texture;
  while (dims.length < 8) dims.push(new THREE.Vector4(1, 1, 0, 0));
  mat.uniforms.uDims.value = dims;
  const quad = new THREE.PlaneGeometry(1, 1, 1, 1).translate(0.5, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry().copy(quad);
  geo.instanceCount = trees.length;
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(trees.length), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aVariant', attr);
  const mesh = new THREE.InstancedMesh(geo, mat, trees.length);
  mesh.name = 'tree-impostors';
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  impostor = { mesh, attr, rt };
}

// ------------------------------------------------------------------------------------------ placement
function blockedByStructures(layout, margin = 1) {
  const rects = [];
  for (const b of layout.buildings) rects.push({ x: b.x, z: b.z, w: b.w + 6 * margin, d: b.d + 6 * margin, yaw: b.yaw });
  for (const s of layout.slabs) rects.push({ x: s.x, z: s.z, w: s.w + 4 * margin, d: s.d + 4 * margin, yaw: s.yaw || 0 });
  for (const f of layout.footprints) rects.push({ x: f.x, z: f.z, w: f.w + 5 * margin, d: f.d + 5 * margin, yaw: f.rot || 0 });
  // bucket the rectangles on a 32 m grid so a test only visits the few nearby
  const CELL = 32, grid = new Map();
  for (const r of rects) {
    r.c = Math.cos(r.yaw); r.s = Math.sin(r.yaw);
    const e = Math.hypot(r.w, r.d) / 2;
    for (let cx = Math.floor((r.x - e) / CELL); cx <= Math.floor((r.x + e) / CELL); cx++) {
      for (let cz = Math.floor((r.z - e) / CELL); cz <= Math.floor((r.z + e) / CELL); cz++) {
        const k = cx * 4096 + cz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(r);
      }
    }
  }
  return (x, z) => {
    const list = grid.get(Math.floor(x / CELL) * 4096 + Math.floor(z / CELL));
    if (!list) return false;
    for (const r of list) {
      const lx = (x - r.x) * r.c - (z - r.z) * r.s, lz = (x - r.x) * r.s + (z - r.z) * r.c;
      if (Math.abs(lx) < r.w / 2 && Math.abs(lz) < r.d / 2) return true;
    }
    return false;
  };
}

const rq = {};
function treeAllowed(x, z, blocked, roadClear = 4) {
  const h = heightAt(x, z);
  if (h < 2.8) return false;
  const r = nearestRoad(x, z, rq, 25);
  if (r && r.edge < roadClear) return false;
  for (const s of ALL_SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * 0.72) return false;
  if (Math.hypot(x - quarry.x, z - quarry.z) < quarry.rim + 6) return false;
  if (blocked(x, z)) return false;
  const n = normalAt(x, z, [0, 1, 0], 1.0);
  return n[1] > 0.8;
}

function pickSpecies(rng, forest) {
  const key = forest ? 'forest' : 'open';
  let tot = 0;
  for (const s of SPECIES) tot += s[key];
  let r = rng.next() * tot;
  for (let i = 0; i < SPECIES.length; i++) { r -= SPECIES[i][key]; if (r <= 0) return i; }
  return 0;
}

function placeTrees(layout) {
  const rng = new Rng(mixSeed(MAP.seed, hashString('trees')));
  const blocked = blockedByStructures(layout);
  const out = [];
  const grid = new Map();
  const cell = 4;
  const near = (x, z, d) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    const k = Math.ceil(d / cell);
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
      const list = grid.get((cx + i) * 4096 + (cz + j));
      if (list) for (const t of list) if (Math.hypot(t.x - x, t.z - z) < d) return true;
    }
    return false;
  };
  const add = (t) => { out.push(t); const key = Math.floor(t.x / cell) * 4096 + Math.floor(t.z / cell); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(t); };
  // forests: rejection sampling inside the discs, min spacing scaled by species size
  let attempts = 0;
  const forestArea = FORESTS.reduce((s, f) => s + f[2] * f[2], 0);
  while (out.length < TUNE.forestTrees && attempts < TUNE.forestTrees * 30) {
    attempts++;
    const pickR = rng.next() * forestArea;
    let acc = 0, F = FORESTS[0];
    for (const f of FORESTS) { acc += f[2] * f[2]; if (acc >= pickR) { F = f; break; } }
    const [x, z] = rng.inDisc(F[0], F[1], F[2] * 1.1);
    const dens = forestAt(x, z);
    if (rng.next() > dens * 1.1) continue;
    const v = pickSpecies(rng, true);
    const s = rng.range(0.78, 1.18);
    const spacing = (v < 2 ? 4.2 : 5.6) * s;
    if (near(x, z, spacing) || !treeAllowed(x, z, blocked)) continue;
    add({ x, y: heightAt(x, z) - 0.15, z, yaw: rng.range(0, Math.PI * 2), s, v, forest: true });
  }
  // countryside: loose clumps and singles
  attempts = 0;
  let open = 0;
  while (open < TUNE.sparseTrees && attempts < TUNE.sparseTrees * 60) {
    attempts++;
    const [cx, cz] = rng.inDisc(0, 0, 470);
    if (forestAt(cx, cz) > 0.2) continue;
    const clump = rng.int(1, 4);
    for (let k = 0; k < clump && open < TUNE.sparseTrees; k++) {
      const x = cx + rng.range(-7, 7), z = cz + rng.range(-7, 7);
      const v = pickSpecies(rng, false);
      const s = rng.range(0.7, 1.15);
      if (near(x, z, 6 * s) || !treeAllowed(x, z, blocked, 5)) continue;
      add({ x, y: heightAt(x, z) - 0.15, z, yaw: rng.range(0, Math.PI * 2), s, v, forest: false });
      open++;
    }
  }
  // garden trees picked by the layout (inside town cores, where the scatter above never goes)
  for (const g of layout.gardenTrees || []) {
    const v = pickSpecies(rng, false);
    add({ x: g.x, y: heightAt(g.x, g.z) - 0.15, z: g.z, yaw: rng.range(0, Math.PI * 2), s: g.s, v, forest: false, garden: true });
  }
  return out;
}

/** Hedge rows from the building yards: bush instances every ~0.8 m, slightly irregular. */
function placeHedges(layout) {
  const rng = new Rng(mixSeed(MAP.seed, hashString('hedges')));
  const out = [];
  for (const h of layout.hedges || []) {
    const [ax, az] = h.a, [bx, bz] = h.b;
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 0.8));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t + rng.range(-0.08, 0.08), z = az + (bz - az) * t + rng.range(-0.08, 0.08);
      out.push({ x, y: heightAt(x, z) - 0.05, z, yaw: rng.range(0, 6.28), s: rng.range(0.52, 0.66), hedge: true });
    }
  }
  return out;
}

function placeBushes(layout) {
  const rng = new Rng(mixSeed(MAP.seed, hashString('bushes')));
  const blocked = blockedByStructures(layout);
  const out = [];
  for (let a = 0; a < TUNE.bushes * 25 && out.length < TUNE.bushes; a++) {
    const [x, z] = rng.inDisc(0, 0, 480);
    const f = forestAt(x, z);
    if (rng.next() > 0.25 + f * 0.75) continue;
    if (!treeAllowed(x, z, blocked, 2.5)) continue;
    out.push({ x, y: heightAt(x, z) - 0.1, z, yaw: rng.range(0, 6.28), s: rng.range(0.7, 1.4) });
  }
  // shuffle so any prefix is spatially uniform (quality scales the visible count)
  rng.shuffle(out);
  return out;
}

// ------------------------------------------------------------------------------------------ rocks
function rockGeometry(seed) {
  const rng = new Rng(seed);
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const sx = rng.range(0.9, 1.6), sy = rng.range(0.45, 0.85), sz = rng.range(0.8, 1.3);
  const ph = [rng.range(0, 10), rng.range(0, 10), rng.range(0, 10)];
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + 0.22 * Math.sin(v.x * 2.7 + ph[0]) * Math.cos(v.z * 2.3 + ph[1]) + 0.12 * Math.sin(v.y * 4.1 + ph[2]) + 0.06 * Math.sin((v.x + v.z) * 7.3);
    v.multiplyScalar(n);
    v.set(v.x * sx, Math.max(v.y * sy, -0.25), v.z * sz);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('uv');
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  // box-projected UVs per face, layer = rock, ao darker toward the ground
  const pos = ng.attributes.position, nrm = ng.attributes.normal;
  const uv = new Float32Array(pos.count * 2), srf = new Float32Array(pos.count * 2), col = new Uint8Array(pos.count * 3);
  const tile = 1 / 3.2;
  for (let f = 0; f < pos.count; f += 3) {
    const fn = new THREE.Vector3();
    for (let k = 0; k < 3; k++) fn.add(new THREE.Vector3().fromBufferAttribute(nrm, f + k));
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const i = f + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (ay >= ax && ay >= az) { uv[i * 2] = x * tile; uv[i * 2 + 1] = z * tile; } else if (ax >= az) { uv[i * 2] = z * tile; uv[i * 2 + 1] = y * tile; } else { uv[i * 2] = x * tile; uv[i * 2 + 1] = y * tile; }
      // grey stone on the gravel set (the rocky aerial scan is mostly grass); colours are stored halved like buildings
      srf[i * 2] = L.gravelly_sand;
      srf[i * 2 + 1] = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.25) / 0.8));
      const tone = 0.5 * (0.86 + 0.1 * Math.sin(seed * 3.7));
      col[i * 3] = tone * 0.58 * 255; col[i * 3 + 1] = tone * 1.0 * 255; col[i * 3 + 2] = Math.min(255, tone * 1.95 * 255);
    }
  }
  ng.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  ng.setAttribute('aSurf', new THREE.BufferAttribute(srf, 2));
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  ng.computeBoundingSphere();
  return ng;
}

function placeRocks(layout) {
  const rng = new Rng(mixSeed(MAP.seed, hashString('rocks')));
  const blocked = blockedByStructures(layout);
  const out = [];
  const tryAdd = (x, z, s) => {
    const h = heightAt(x, z);
    if (h < 0.5 || blocked(x, z)) return;
    const r = nearestRoad(x, z, rq, 20);
    if (r && r.edge < 2 + s) return;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 2 + s * 1.5)) return;
    const n = normalAt(x, z, [0, 1, 0], 1.0);
    out.push({ x, y: h - 0.25 * s, z, s, yaw: rng.range(0, 6.28), v: rng.int(0, 3), tilt: [n[0] * 0.6, n[2] * 0.6] });
  };
  // quarry rubble, the hill, the shoreline and scattered field stones
  for (let i = 0; i < 70; i++) { const [x, z] = rng.inDisc(quarry.x, quarry.z, quarry.rim + 30); tryAdd(x, z, rng.range(0.5, 2.0)); }
  const sig = ALL_SITES.find((s) => s.id === 'signal');
  for (let i = 0; i < 60; i++) { const [x, z] = rng.inDisc(sig.x, sig.z, 190); if (Math.hypot(x - sig.x, z - sig.z) > sig.r) tryAdd(x, z, rng.range(0.6, 2.4)); }
  for (let i = 0; i < 400 && out.length < TUNE.rocks; i++) {
    const a = rng.range(0, Math.PI * 2), rr = rng.range(420, 505);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const h = heightAt(x, z);
    if (h > 0.6 && h < 9 && normalAt(x, z, [0, 1, 0], 2)[1] < 0.9) tryAdd(x, z, rng.range(0.6, 2.6));
  }
  for (let i = 0; i < 600 && out.length < TUNE.rocks; i++) {
    const [x, z] = rng.inDisc(0, 0, 450);
    if (ALL_SITES.some((s) => Math.hypot(x - s.x, z - s.z) < s.r * 0.85)) continue;
    tryAdd(x, z, rng.range(0.35, 1.3) * (forestAt(x, z) > 0.3 ? 1.3 : 1));
  }
  return out;
}

// ------------------------------------------------------------------------------------------ grass
const GRASS_VERT = /* glsl */`
  float zfH = position.y;
  vec3 zfIp2 = vec3( 0.0 );
  #ifdef USE_INSTANCING
    zfIp2 = instanceMatrix[ 3 ].xyz;
  #endif
  float zfD = length( zfIp2.xz - uGrassCentre.xz );
  float zfFade = 1.0 - smoothstep( uGrassR * 0.65, uGrassR, zfD );
  transformed.y *= zfFade;
  float zfPh2 = dot( zfIp2.xz, vec2( 0.31, 0.27 ) );
  float zfB = zfH * zfH * 1.6;
  transformed.x += ( sin( uWindTime * 1.9 + zfPh2 ) * 0.10 + sin( uWindTime * 4.3 + zfPh2 * 2.1 ) * 0.04 ) * zfB;
  transformed.z += ( cos( uWindTime * 1.6 + zfPh2 * 1.4 ) * 0.08 ) * zfB;
  vGrassH = zfH;
`;

function grassClump() {
  const rng = new Rng(4242);
  const pos = [], nrm = [], idx = [];
  const blades = 15, segs = 2;
  for (let b = 0; b < blades; b++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * 0.42;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const yaw = rng.range(0, Math.PI * 2);
    const h = rng.range(0.2, 0.48), w = rng.range(0.014, 0.026);
    const lean = rng.range(0.08, 0.3);
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const lx = -dz, lz = dx;
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const ww = w * (1 - t * 0.75);
      const off = lean * t * t;
      const cx = bx + dx * off, cz = bz + dz * off, cy = h * t;
      pos.push(cx - lx * ww, cy, cz - lz * ww, cx + lx * ww, cy, cz + lz * ww);
      // normals lean toward the sky so blades shade like the ground they grow from
      nrm.push(dx * 0.25, 1, dz * 0.25, dx * 0.25, 1, dz * 0.25);
    }
    for (let s = 0; s < segs; s++) {
      const i0 = base + s * 2;
      idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.normalizeNormals();
  g.setIndex(idx);
  return g;
}

function grassMaskFn(layout) {
  const blocked = blockedByStructures(layout, 0.2);
  const pw = new Float32Array(5);
  return (x, z) => {
    const h = heightAt(x, z);
    if (h < 3.2) return 0;
    paintAt(x, z, pw);
    if (pw[4] < 1.2) return 0;
    let d = 1 - Math.max(pw[0], pw[3]) * 1.9 - pw[2] * 0.6 - pw[1] * 0.25;
    if (d <= 0.4) return 0;
    if (blocked(x, z)) return 0;
    return Math.min(1, d);
  };
}

function buildGrass(layout) {
  const geo = grassClump();
  const mat = new THREE.MeshStandardMaterial({ name: 'zf-grass', color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const uniforms = { uGrassCentre: { value: new THREE.Vector3() }, uGrassR: { value: 30 }, tNoise: { value: noiseTexture() } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.uniforms.uWindTime = windUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform vec3 uGrassCentre;\nuniform float uGrassR;\nuniform sampler2D tNoise;\nvarying float vGrassH;\nvarying vec3 vGrassTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GRASS_VERT + `
        // same macro fields as the terrain splat (materials.js), so blades match the ground they stand on
        vec4 gNs = textureLod( tNoise, zfIp2.xz / 173.0, 0.0 );
        vec4 gNd = textureLod( tNoise, zfIp2.xz / 23.0, 0.0 );
        vec4 gNb = textureLod( tNoise, zfIp2.xz / 690.0 + 0.31, 0.0 );
        float gDry = smoothstep( 0.46, 0.8, gNb.x * 0.5 + gNs.y * 0.42 + smoothstep( 16.0, 46.0, zfIp2.y ) * 0.16 );
        float gLush = smoothstep( 0.52, 0.8, gNs.z * 0.55 + gNb.y * 0.45 ) * ( 1.0 - gDry );
        vec3 gC = mix( vec3( 0.074, 0.104, 0.030 ), vec3( 0.142, 0.132, 0.056 ), gDry );
        gC = mix( gC, vec3( 0.046, 0.074, 0.020 ), gLush * 0.85 ) * ( 0.88 + 0.24 * gNd.w );
        float zfHash = fract( sin( dot( zfIp2.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        vGrassTint = gC * ( 0.85 + 0.3 * zfHash );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGrassH;\nvarying vec3 vGrassTint;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );\nnonPerturbedNormal = normal;')
      .replace('#include <map_fragment>', 'diffuseColor.rgb = vGrassTint * mix( 0.55, 1.45, smoothstep( 0.0, 0.5, vGrassH ) );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.06 * smoothstep( 0.1, 0.5, vGrassH );');
  };
  mat.customProgramCacheKey = () => 'zf-grass';
  const cap = 9000;
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = 'grass';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  grass = { mesh, uniforms, mask: grassMaskFn(layout), tiles: new Map(), lastKey: '', cap };
}

function grassTile(tx, tz) {
  const key = tx * 10000 + tz;
  let t = grass.tiles.get(key);
  if (t) return t;
  const S = TUNE.grassTile, sp = TUNE.grassSpacing;
  const n = Math.floor(S / sp);
  const mats = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const rng = new Rng(mixSeed(tx * 73856093 >>> 0, tz * 19349663 >>> 0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = tx * S + (i + rng.next()) * sp, z = tz * S + (j + rng.next()) * sp;
    const d = grass.mask(x, z);
    if (d <= 0 || rng.next() > d) continue;
    p.set(x, heightAt(x, z) - 0.02, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng.range(0, 6.28));
    const s = rng.range(0.75, 1.35) * (0.6 + 0.4 * d);
    sc.set(s, s * rng.range(0.8, 1.25), s);
    mats.push(m.compose(p, q, sc).clone());
  }
  t = { mats };
  grass.tiles.set(key, t);
  return t;
}

function updateGrass(viewPos) {
  if (!grass || !qual || qual.grass <= 0) { if (grass) grass.mesh.count = 0; return; }
  const R = TUNE.grassRadius[qual.grass >= 1 ? 1 : 0.5] || 26;
  const S = TUNE.grassTile;
  const tx0 = Math.floor((viewPos.x - R) / S), tx1 = Math.floor((viewPos.x + R) / S);
  const tz0 = Math.floor((viewPos.z - R) / S), tz1 = Math.floor((viewPos.z + R) / S);
  const key = `${tx0},${tz0},${R}`;
  grass.uniforms.uGrassCentre.value.copy(viewPos);
  grass.uniforms.uGrassR.value = R;
  const alt = viewPos.y - heightAt(viewPos.x, viewPos.z);
  if (alt > 60) { grass.mesh.count = 0; grass.lastKey = ''; return; }
  if (key === grass.lastKey) return;
  // tiles nearest the viewer first; new tiles are generated within a per-frame time budget and the rest next frame
  const want = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
    const dd = Math.hypot((tx + 0.5) * S - viewPos.x, (tz + 0.5) * S - viewPos.z);
    if (dd <= R + S * 0.71) want.push([dd, tx, tz]);
  }
  want.sort((a, b) => a[0] - b[0]);
  const t0 = performance.now();
  let complete = true;
  let c = 0;
  const step = qual.grass >= 1 ? 1 : 2;
  for (const [, tx, tz] of want) {
    let t = grass.tiles.get(tx * 10000 + tz);
    if (!t) {
      if (performance.now() - t0 > TUNE.grassBudgetMs) { complete = false; continue; }
      t = grassTile(tx, tz);
    }
    for (let i = 0; i < t.mats.length && c < grass.cap; i += step) grass.mesh.setMatrixAt(c++, t.mats[i]);
  }
  grass.lastKey = complete ? key : '';
  grass.mesh.count = c;
  grass.mesh.instanceMatrix.needsUpdate = true;
  stats.grass = c;
  // forget far tiles
  if (grass.tiles.size > 400) for (const k of grass.tiles.keys()) { const tx = Math.floor(k / 10000); if (Math.abs(tx * S - viewPos.x) > 200) grass.tiles.delete(k); }
}

// ------------------------------------------------------------------------------------------ build
/**
 * @param {THREE.Object3D} scene
 * @param {object} layout
 * @param {object} quality
 */
export async function buildFoliage(scene, layout, quality, onProgress = () => {}) {
  qual = quality;
  root = new THREE.Group();
  root.name = 'foliage';
  scene.add(root);
  try {
    const mod = await import(/* @vite-ignore */ SIMPLIFIER_URL);
    simplifier = mod.MeshoptSimplifier;
    await simplifier.ready;
  } catch (e) { simplifier = null; }
  onProgress(0.05);
  const { Tree } = await import('ez-tree');
  onProgress(0.25);
  variants = [];
  for (const sp of SPECIES) { variants.push(await grow(Tree, sp)); onProgress(0.25 + 0.3 * (variants.length / SPECIES.length)); await frame(); }
  const bushV = await grow(Tree, BUSH);
  trees = placeTrees(layout);
  stats.trees = trees.length;
  onProgress(0.62);
  await frame();
  // instanced LOD meshes per species
  treeMeshes = variants.map((v, vi) => {
    const count = trees.filter((t) => t.v === vi).length;
    const mk = (geo, mat, name, shadow) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      im.name = name; im.count = 0; im.castShadow = shadow; im.receiveShadow = true; im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(im);
      return im;
    };
    return {
      l0b: mk(v.lod0.bark, v.barkMat, `tree${vi}_bark0`, true), l0l: mk(v.lod0.leaves, v.leafMat, `tree${vi}_leaves0`, true),
      l1b: mk(v.lod1.bark, v.barkMat, `tree${vi}_bark1`, true), l1l: mk(v.lod1.leaves, v.leafMat, `tree${vi}_leaves1`, true),
      l1bn: mk(v.lod1.bark, v.barkMat, `tree${vi}_bark1_ns`, false), l1ln: mk(v.lod1.leaves, v.leafMat, `tree${vi}_leaves1_ns`, false),
    };
  });
  for (const t of trees) {
    t.m = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.yaw), new THREE.Vector3(t.s, t.s, t.s));
  }
  bakeImpostors(scene.parent || scene);
  onProgress(0.75);
  await frame();
  // bushes (no colliders); hedge rows first so they are always drawn regardless of the foliage density
  hedges = placeHedges(layout);
  bushes = hedges.concat(placeBushes(layout));
  bushMesh = { b: new THREE.InstancedMesh(bushV.lod1.bark, bushV.barkMat, bushes.length), l: new THREE.InstancedMesh(bushV.lod0.leaves, bushV.leafMat, bushes.length) };
  for (const im of [bushMesh.b, bushMesh.l]) { im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(im); }
  bushMesh.b.name = 'bush_bark'; bushMesh.l.name = 'bush_leaves';
  for (const b of bushes) b.m = new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.y, b.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, b.yaw), new THREE.Vector3(b.s, b.s * 0.9, b.s));
  // rocks
  rocks = placeRocks(layout);
  const rockGeos = [0, 1, 2, 3].map((i) => rockGeometry(9000 + i * 17));
  const rockMat = surfaceMaterial();
  rockMeshes = rockGeos.map((g, i) => {
    const list = rocks.filter((r) => r.v === i);
    const im = new THREE.InstancedMesh(g, rockMat, Math.max(1, list.length));
    im.name = `rocks${i}`;
    list.forEach((r, k) => {
      r.m = new THREE.Matrix4().compose(new THREE.Vector3(r.x, r.y, r.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r.tilt[1], r.yaw, -r.tilt[0], 'YXZ')), new THREE.Vector3(r.s, r.s, r.s));
      im.setMatrixAt(k, r.m);
    });
    im.count = list.length;
    im.castShadow = true; im.receiveShadow = true;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(im);
    return { im, geo: g, list };
  });
  stats.rocks = rocks.length;
  buildGrass(layout);
  onProgress(1);
  return root;
}

/** Trunk prisms and rock hulls into the static collision set. */
export function addColliders(set) {
  for (const t of trees) {
    const v = variants[t.v];
    set.prism(t.x, t.z, t.y - 0.3, t.y + Math.min(5.5, v.h * 0.35) * t.s, Math.max(0.12, v.trunkR * t.s), 7, SURFACE.WOOD);
  }
  for (const r of rocks) set.geometry(rockMeshes[r.v].geo, r.m, SURFACE.ROCK);
}

export const rockPositions = () => rocks.map((r) => [r.x, r.y + r.s * 0.4, r.z]);
/** Trees as {x, z, canopy (diameter m), trunk (radius m)} for the baked ground occlusion. */
export const treeFootprints = () => trees.map((t) => ({ x: t.x, z: t.z, canopy: variants[t.v].radius * 1.4 * t.s, trunk: Math.max(0.12, variants[t.v].trunkR * t.s) }));
/** Rocks as {x, z, d (diameter m)}. */
export const rockFootprints = () => rocks.map((r) => ({ x: r.x, z: r.z, d: r.s * 2.2 }));

/** Quality switch: bush density and grass; tree LOD radii come from treeLodDistance. */
export function applyQuality(q) { qual = q; acc = TUNE.update; lastView.set(1e9, 0, 0); if (grass) grass.lastKey = ''; }

// ------------------------------------------------------------------------------------------ per frame
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
export function updateFoliage(dt, viewPos, camera) {
  if (!root) return;
  windUniform.value += dt * TUNE.windSpeed;
  updateGrass(viewPos);
  acc += dt;
  if (acc < TUNE.update && lastView.distanceToSquared(viewPos) < 9) return;
  acc = 0;
  lastView.copy(viewPos);
  const lodFar = qual.treeLodDistance, view = qual.viewDistance;
  const lodNear = Math.min(TUNE.nearMax, Math.max(TUNE.nearMin, lodFar * TUNE.nearFrac));
  const shadowR = Math.max(lodNear, shadowExtent() * TUNE.shadowPad);
  if (camera) { _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frustum.setFromProjectionMatrix(_pv); }
  for (const tm of treeMeshes) { tm.l0b.count = tm.l0l.count = tm.l1b.count = tm.l1l.count = tm.l1bn.count = tm.l1ln.count = 0; }
  let far = 0, near = 0, mid = 0;
  const vattr = impostor.attr.array;
  for (const t of trees) {
    const d = Math.hypot(t.x - viewPos.x, t.y - viewPos.y, t.z - viewPos.z);
    if (d > view) continue;
    const v = variants[t.v];
    if (camera) { _sph.center.set(t.x, t.y + v.h * 0.5 * t.s, t.z); _sph.radius = v.h * 0.6 * t.s + 2; if (!_frustum.intersectsSphere(_sph)) continue; }
    const tm = treeMeshes[t.v];
    if (d < lodNear) { tm.l0b.setMatrixAt(tm.l0b.count++, t.m); tm.l0l.setMatrixAt(tm.l0l.count++, t.m); near++; }
    else if (d < lodFar) {
      if (d < shadowR) { tm.l1b.setMatrixAt(tm.l1b.count++, t.m); tm.l1l.setMatrixAt(tm.l1l.count++, t.m); }
      else { tm.l1bn.setMatrixAt(tm.l1bn.count++, t.m); tm.l1ln.setMatrixAt(tm.l1ln.count++, t.m); }
      mid++;
    }
    else { impostor.mesh.setMatrixAt(far, t.m); vattr[far] = t.v; far++; }
  }
  for (const tm of treeMeshes) for (const im of [tm.l0b, tm.l0l, tm.l1b, tm.l1l, tm.l1bn, tm.l1ln]) { im.instanceMatrix.needsUpdate = true; im.visible = im.count > 0; }
  // rocks: distance-culled buckets (static colliders are unaffected)
  const rockR = qual.propDistance * TUNE.rockCull;
  for (const rm of rockMeshes) {
    let c = 0;
    for (const r of rm.list) {
      if (Math.abs(r.x - viewPos.x) > rockR || Math.abs(r.z - viewPos.z) > rockR) continue;
      if (Math.hypot(r.x - viewPos.x, r.z - viewPos.z) > rockR) continue;
      rm.im.setMatrixAt(c++, r.m);
    }
    rm.im.count = c; rm.im.visible = c > 0; rm.im.instanceMatrix.needsUpdate = true;
  }
  impostor.mesh.count = far;
  impostor.mesh.geometry.instanceCount = far;
  impostor.mesh.instanceMatrix.needsUpdate = true;
  impostor.attr.needsUpdate = true;
  impostor.mesh.visible = far > 0;
  // bushes: visible count scales with quality.foliage, culled at 45 % of the tree LOD distance
  const nb = hedges.length + Math.floor((bushes.length - hedges.length) * Math.min(1, qual.foliage / 1.0));
  let bc = 0;
  const bushR = Math.max(70, lodFar * 0.45);
  for (let i = 0; i < nb; i++) {
    const b = bushes[i];
    if (Math.abs(b.x - viewPos.x) > bushR || Math.abs(b.z - viewPos.z) > bushR) continue;
    if (Math.hypot(b.x - viewPos.x, b.z - viewPos.z) > bushR) continue;
    bushMesh.b.setMatrixAt(bc, b.m); bushMesh.l.setMatrixAt(bc, b.m); bc++;
  }
  bushMesh.b.count = bushMesh.l.count = bc;
  bushMesh.b.instanceMatrix.needsUpdate = bushMesh.l.instanceMatrix.needsUpdate = true;
  stats.near = near; stats.mid = mid; stats.far = far; stats.bushes = bc;
}

export function foliageStats() {
  const tris = treeMeshes.reduce((s, tm, i) => s + tm.l0b.count * variants[i].tris0 + (tm.l1b.count + tm.l1bn.count) * variants[i].tris1, 0);
  return { ...stats, treeTris: tris, variants: variants.map((v) => ({ preset: v.sp.preset, tris0: v.tris0, tris1: v.tris1, h: v.h })) };
}
