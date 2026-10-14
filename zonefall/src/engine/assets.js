// ZONEFALL - asset loading and caches. OWNER: WORLD. Contract: ARCHITECTURE.md 5.1
// Every file is fetched as a byte stream so the loading bar shows real byte progress, then decoded:
// GLB through GLTFLoader + MeshoptDecoder (all GLBs are meshopt + WebP), JPG through an <img> decode, HDR through
// HDRLoader (float). Colour textures are sRGB, normal/arm maps linear, all RepeatWrapping with the tier anisotropy.
// The 'arm' map packs AO (R), roughness (G), metalness (B) and is used as aoMap, roughnessMap and metalnessMap.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ASSETS, RENDER, QUALITY, assetUrl, textureUrl } from '../config.js';
import { on, EV } from '../core/bus.js';
import { state } from '../core/state.js';

const TUNE = {
  concurrency: 8,          // parallel downloads
  bytesWeight: 0.85,       // share of the bar given to bytes; the rest is decoding
  estModel: 700e3,         // byte estimates used until a response reports Content-Length
  estTexture: 220e3,
  estHdr: 1.4e6,
  estBg: 260e3,
};

const MAPS = ['diff', 'nor_gl', 'arm'];

let gltfLoader = null;
const models = new Map();     // key -> gltf
const textures = new Map();   // 'id|map' -> Texture
const materials = new Map();  // cache key -> MeshStandardMaterial
const skies = new Map();      // key -> {hdr, bg}
const arrays = new Map();     // 'map|size|ids' -> DataArrayTexture
let clipMap = null;
let loaded = false;
let anisotropy = 4;

function err(msg) { return new Error(`[WORLD/assets] ${msg}`); }

/** The shared GLTFLoader (meshopt enabled) for groups that load extra files. */
export function loader() {
  if (!gltfLoader) gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return gltfLoader;
}

// ------------------------------------------------------------------------------------------ byte streaming
async function fetchBytes(job, tick) {
  const res = await fetch(job.url);
  if (!res.ok) throw err(`HTTP ${res.status} for ${job.url}`);
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > 0) job.total = len;
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    job.loaded = job.total = buf.byteLength;
    tick();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    job.loaded = Math.min(got, job.total);
    tick();
  }
  job.loaded = job.total = got;   // compressed transfers report a smaller Content-Length than the stream yields
  tick();
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

async function pool(jobs, limit, run) {
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, jobs.length); w++) {
    workers.push((async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await run(job);
      }
    })());
  }
  await Promise.all(workers);
}

// ------------------------------------------------------------------------------------------ decoders
function decodeImage(buf, mime) {
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  return img.decode().then(() => { URL.revokeObjectURL(url); return img; }, (e) => {
    URL.revokeObjectURL(url);
    throw err(`could not decode image (${e && e.message})`);
  });
}

function configureTexture(tex, map) {
  tex.colorSpace = map === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function parseGLB(buf, url) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  return new Promise((resolve, reject) => loader().parse(buf, base, resolve, (e) => reject(err(`GLB parse failed for ${url}: ${e && e.message}`))));
}

function parseHDR(buf) {
  const l = new HDRLoader().setDataType(THREE.FloatType);
  const tex = l.createDataTexture(buf);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------ public API
/**
 * Load every model in ASSETS.models, every texture set in ASSETS.textures and the RENDER.sky HDRI.
 * @param {(p:number, label:string) => void} onProgress  p in 0..1, never decreasing
 */
export async function loadCore(onProgress = () => {}) {
  if (loaded) { onProgress(1, 'Assets ready'); return; }
  await MeshoptDecoder.ready;
  anisotropy = currentAnisotropy();

  const jobs = [];
  for (const [key, path] of Object.entries(ASSETS.models)) jobs.push({ kind: 'model', key, url: assetUrl(path), total: TUNE.estModel, loaded: 0, done: false, label: 'Models' });
  for (const id of Object.keys(ASSETS.textures)) {
    for (const map of MAPS) jobs.push({ kind: 'tex', key: `${id}|${map}`, id, map, url: textureUrl(id, map), total: TUNE.estTexture, loaded: 0, done: false, label: 'Textures' });
  }
  const skyKey = RENDER.sky;
  const skyDef = ASSETS.hdri[skyKey];
  if (!skyDef) throw err(`RENDER.sky '${skyKey}' is not in ASSETS.hdri`);
  jobs.push({ kind: 'hdr', key: skyKey, url: assetUrl(skyDef.hdr), total: TUNE.estHdr, loaded: 0, done: false, label: 'Sky' });
  jobs.push({ kind: 'bg', key: skyKey, url: assetUrl(skyDef.bg), total: TUNE.estBg, loaded: 0, done: false, label: 'Sky' });

  let shown = 0;
  let lastLabel = 'Models';
  const tick = (label) => {
    if (label) lastLabel = label;
    let tot = 0, got = 0, done = 0;
    for (const j of jobs) { tot += j.total; got += j.loaded; if (j.done) done++; }
    const p = TUNE.bytesWeight * (tot > 0 ? got / tot : 0) + (1 - TUNE.bytesWeight) * (done / jobs.length);
    if (p > shown) { shown = Math.min(1, p); onProgress(shown, lastLabel); }
  };

  const hdrParts = {};
  await pool(jobs, TUNE.concurrency, async (job) => {
    const buf = await fetchBytes(job, () => tick(job.label));
    if (job.kind === 'model') {
      models.set(job.key, await parseGLB(buf, job.url));
    } else if (job.kind === 'tex') {
      const img = await decodeImage(buf, 'image/jpeg');
      textures.set(job.key, configureTexture(new THREE.Texture(img), job.map));
    } else if (job.kind === 'hdr') {
      hdrParts.hdr = parseHDR(buf);
    } else if (job.kind === 'bg') {
      const img = await decodeImage(buf, 'image/jpeg');
      const bg = new THREE.Texture(img);
      bg.mapping = THREE.EquirectangularReflectionMapping;
      bg.colorSpace = THREE.SRGBColorSpace;
      bg.generateMipmaps = true;
      bg.minFilter = THREE.LinearMipmapLinearFilter;
      bg.anisotropy = anisotropy;
      bg.needsUpdate = true;
      hdrParts.bg = bg;
    }
    job.done = true;
    tick(job.label);
  });
  skies.set(skyKey, { hdr: hdrParts.hdr, bg: hdrParts.bg });

  // Shadows on, and no transmissive materials: one visible KHR_materials_transmission surface (the generator's
  // glass, scope lenses) makes three.js re-render every opaque object into a transmission buffer, doubling the
  // whole frame. Glass becomes a glossy, slightly see-through standard surface instead.
  for (const gltf of models.values()) {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.transmission > 0) glassify(m);
    });
  }
  loaded = true;
  onProgress(1, 'Assets ready');
}

function glassify(m) {
  m.transmission = 0;
  m.thickness = 0;
  m.transparent = true;
  m.opacity = 0.42;
  m.depthWrite = false;
  m.roughness = Math.min(m.roughness ?? 0.1, 0.12);
  m.metalness = 0;
  m.color.multiplyScalar(0.35);
  m.forceSinglePass = true;
  m.needsUpdate = true;
}

/** Loaded GLTF ({scene, animations}) for an ASSETS.models key. Shared: never mutate or add it to the scene. */
export function model(key) {
  const g = models.get(key);
  if (!g) throw err(`model '${key}' is not loaded (keys: ${[...models.keys()].join(', ') || 'none - call loadCore first'})`);
  return g;
}

/** Deep clone of a model's scene ready to add to a scene (SkeletonUtils.clone for skinned meshes; materials shared). */
export function cloneModel(key) {
  const g = model(key);
  let skinned = false;
  g.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  return skinned ? SkeletonUtils.clone(g.scene) : g.scene.clone(true);
}

/** Animation clips of soldier_a by name ({Idle, Walk, Rifle_Aim, ...}); they also play on soldier_b. */
export function clips() {
  if (!clipMap) {
    clipMap = {};
    for (const c of model('soldier_a').animations) clipMap[c.name] = c;
  }
  return clipMap;
}

/** Configured texture of a Poly Haven set. map: 'diff' | 'nor_gl' | 'arm'. */
export function texture(id, map) {
  if (!MAPS.includes(map)) throw err(`unknown texture map '${map}' (use diff, nor_gl or arm)`);
  const t = textures.get(`${id}|${map}`);
  if (!t) throw err(`texture '${id}' (${map}) is not loaded`);
  return t;
}

function withRepeat(tex, rx, ry) {
  if (rx === 1 && ry === 1) return tex;
  const c = tex.clone();      // shares the image Source, so the GPU upload is shared too
  c.repeat.set(rx, ry);
  c.needsUpdate = true;
  return c;
}

/**
 * Cached MeshStandardMaterial for a texture set.
 * @param {string} id  ASSETS.textures key
 * @param {{repeat?:number|[number,number], tint?:number, roughness?:number, metalness?:number, normalScale?:number}} [opts]
 *        repeat defaults to 1 (UVs are expected in metres / tile size); tint multiplies the albedo
 */
export function pbr(id, opts = {}) {
  if (!(id in ASSETS.textures)) throw err(`unknown texture set '${id}'`);
  const rep = opts.repeat == null ? [1, 1] : Array.isArray(opts.repeat) ? opts.repeat : [opts.repeat, opts.repeat];
  const tint = opts.tint == null ? 0xffffff : opts.tint;
  const rough = opts.roughness == null ? 1 : opts.roughness;
  const metal = opts.metalness == null ? 1 : opts.metalness;
  const ns = opts.normalScale == null ? 1 : opts.normalScale;
  const key = `${id}|${rep[0]},${rep[1]}|${tint}|${rough}|${metal}|${ns}|${opts.vertexColors ? 1 : 0}`;
  let m = materials.get(key);
  if (m) return m;
  const arm = withRepeat(texture(id, 'arm'), rep[0], rep[1]);
  m = new THREE.MeshStandardMaterial({
    name: `pbr:${id}`,
    map: withRepeat(texture(id, 'diff'), rep[0], rep[1]),
    normalMap: withRepeat(texture(id, 'nor_gl'), rep[0], rep[1]),
    aoMap: arm, roughnessMap: arm, metalnessMap: arm,
    color: new THREE.Color(tint),
    roughness: rough, metalness: metal,
    normalScale: new THREE.Vector2(ns, ns),
    vertexColors: !!opts.vertexColors,
  });
  materials.set(key, m);
  return m;
}

const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

/**
 * One DataArrayTexture holding the same map of several texture sets (layer i = ids[i]), resampled to size x size.
 * Rows are stored bottom-up so array layers sample exactly like flipY image textures (OpenGL normal maps stay
 * correct). Mipmapped, RepeatWrapping, tier anisotropy; the CPU copy is released after the GPU upload. Cached.
 * @param {string[]} ids  ASSETS.textures keys
 * @param {'diff'|'nor_gl'|'arm'} map
 * @param {number} [size]
 * @returns {Promise<THREE.DataArrayTexture>}
 */
export async function textureArray(ids, map, size = 1024) {
  const key = `${map}|${size}|${ids.join(',')}`;
  if (arrays.has(key)) return arrays.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const layerBytes = size * size * 4;
  const data = new Uint8Array(layerBytes * ids.length);
  for (let i = 0; i < ids.length; i++) {
    const img = texture(ids[i], map).image;
    ctx.setTransform(1, 0, 0, -1, 0, size);
    ctx.drawImage(img, 0, 0, size, size);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    data.set(ctx.getImageData(0, 0, size, size).data, i * layerBytes);
    if (i % 3 === 2) await nextFrame();
  }
  const tex = new THREE.DataArrayTexture(data, size, size, ids.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = map === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.unpackAlignment = 4;
  tex.onUpdate = () => { tex.image.data = null; tex.onUpdate = null; };
  tex.needsUpdate = true;
  arrays.set(key, tex);
  return tex;
}

/** {hdr: DataTexture (equirect, for PMREM), bg: Texture (equirect sRGB background)} for an ASSETS.hdri key. */
export function sky(key) {
  const s = skies.get(key);
  if (!s) throw err(`sky '${key}' is not loaded (loadCore loads RENDER.sky = '${RENDER.sky}'; use loadSky for others)`);
  return s;
}

/** Load an additional ASSETS.hdri entry (not part of loadCore). Resolves to {hdr, bg}. */
export async function loadSky(key) {
  if (skies.has(key)) return skies.get(key);
  const def = ASSETS.hdri[key];
  if (!def) throw err(`unknown sky '${key}'`);
  const noop = () => {};
  const [hb, bb] = await Promise.all([
    fetchBytes({ url: assetUrl(def.hdr), total: 1, loaded: 0 }, noop),
    fetchBytes({ url: assetUrl(def.bg), total: 1, loaded: 0 }, noop),
  ]);
  const bgImg = await decodeImage(bb, 'image/jpeg');
  const bg = new THREE.Texture(bgImg);
  bg.mapping = THREE.EquirectangularReflectionMapping;
  bg.colorSpace = THREE.SRGBColorSpace;
  bg.needsUpdate = true;
  const s = { hdr: parseHDR(hb), bg };
  skies.set(key, s);
  return s;
}

/** True once loadCore has finished. */
export const isLoaded = () => loaded;

function currentAnisotropy() {
  const q = QUALITY[state.quality] || QUALITY.medium;
  return q.anisotropy;
}

on(EV.QUALITY_CHANGED, () => {
  const a = currentAnisotropy();
  if (a === anisotropy) return;
  anisotropy = a;
  for (const t of textures.values()) { t.anisotropy = a; t.needsUpdate = true; }
  for (const m of materials.values()) {
    for (const k of ['map', 'normalMap', 'aoMap']) if (m[k] && m[k].anisotropy !== a) { m[k].anisotropy = a; m[k].needsUpdate = true; }
  }
});
