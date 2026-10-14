// ZONEFALL - world materials built on shared PBR texture arrays. OWNER: WORLD (internal).
// All 13 Poly Haven sets live in three DataArrayTextures (albedo, normal, ARM), so the whole terrain is one shader
// and every building of a site is one draw call: geometry carries the layer index, an ambient-occlusion factor and
// a tint per vertex. Materials stay MeshStandardMaterial (image-based light, shadows, the atmospheric fog chunk);
// onBeforeCompile swaps the texture fetches for array fetches and splat logic.
import * as THREE from 'three';
import { ASSETS } from '../config.js';
import * as assets from '../engine/assets.js';
import { TUNE as HF, quarry } from './heightfield.js';

/** Array layer order (index = layer id used by geometry and shaders). */
export const LAYER_IDS = ['sparse_grass', 'leafy_grass', 'forrest_ground_01', 'brown_mud_02', 'rocky_terrain_02', 'gravelly_sand',
  'asphalt_02', 'concrete_floor_worn_001', 'concrete_wall_008', 'red_brick_03', 'corrugated_iron', 'weathered_brown_planks', 'green_metal_rust'];
export const L = Object.freeze(Object.fromEntries(LAYER_IDS.map((id, i) => [id, i])));
/** Real-world tile size (m) per layer; geometry UVs are metres / tile. */
export const TILE = LAYER_IDS.map((id) => ASSETS.textures[id]);

let arrays = null;
let noiseTex = null;

/** Build (once) the albedo / normal / ARM arrays at the given resolution. */
export async function buildArrays(size) {
  if (arrays) return arrays;
  const diff = await assets.textureArray(LAYER_IDS, 'diff', size);
  const avg = layerAverages(diff);
  const nor = await assets.textureArray(LAYER_IDS, 'nor_gl', size);
  const arm = await assets.textureArray(LAYER_IDS, 'arm', size);
  arrays = { diff, nor, arm, size, avg };
  return arrays;
}

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** Mean linear albedo of every array layer (read from the CPU copy before it is uploaded and released). */
function layerAverages(tex) {
  const { data, width, height, depth } = tex.image;
  const out = [];
  const layer = width * height * 4;
  for (let l = 0; l < depth; l++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = l * layer; i < (l + 1) * layer; i += 4 * 97) { r += s2l(data[i] / 255); g += s2l(data[i + 1] / 255); b += s2l(data[i + 2] / 255); n++; }
    out.push(new THREE.Vector3(r / n, g / n, b / n));
  }
  return out;
}
export const getArrays = () => arrays;

// ------------------------------------------------------------------------------------------ tiling noise
function periodicNoise(size, freq, seed) {
  const lat = new Float32Array(freq * freq);
  let s = seed >>> 0;
  for (let i = 0; i < lat.length; i++) { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; lat[i] = (s >>> 8) / 16777216; }
  const out = new Float32Array(size * size);
  const q = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * freq, iy = Math.floor(fy), ty = q(fy - iy);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * freq, ix = Math.floor(fx), tx = q(fx - ix);
      const a = lat[(iy % freq) * freq + (ix % freq)], b = lat[(iy % freq) * freq + ((ix + 1) % freq)];
      const c = lat[((iy + 1) % freq) * freq + (ix % freq)], d = lat[((iy + 1) % freq) * freq + ((ix + 1) % freq)];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** 256 x 256 tileable RGBA value-noise texture; each channel a different frequency band (fbm-ish). */
export function noiseTexture() {
  if (noiseTex) return noiseTex;
  const S = 256;
  const bands = [[4, 8, 16], [8, 16, 32], [16, 32, 64], [32, 64, 128]];
  const data = new Uint8Array(S * S * 4);
  bands.forEach((freqs, ch) => {
    const acc = new Float32Array(S * S);
    let amp = 1, norm = 0;
    freqs.forEach((f, k) => {
      const n = periodicNoise(S, f, 1337 + ch * 101 + k * 7);
      for (let i = 0; i < acc.length; i++) acc[i] += n[i] * amp;
      norm += amp; amp *= 0.5;
    });
    for (let i = 0; i < acc.length; i++) data[i * 4 + ch] = Math.round(Math.min(1, Math.max(0, acc[i] / norm)) * 255);
  });
  noiseTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

// ------------------------------------------------------------------------------------------ shared GLSL
const GLSL_ARRAYS = /* glsl */`
uniform highp sampler2DArray tDiff;
uniform highp sampler2DArray tNor;
uniform highp sampler2DArray tArm;
mat3 zfTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
  vec3 q0 = dFdx( eye_pos.xyz );
  vec3 q1 = dFdy( eye_pos.xyz );
  vec2 st0 = dFdx( uv.st );
  vec2 st1 = dFdy( uv.st );
  vec3 N = surf_norm;
  vec3 q1perp = cross( q1, N );
  vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, N );
}
`;

const AO_CHUNK = (aoExpr) => /* glsl */`
  float ambientOcclusion = ${aoExpr};
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
`;

function arrayUniforms(a) {
  return { tDiff: { value: a.diff }, tNor: { value: a.nor }, tArm: { value: a.arm } };
}

// ------------------------------------------------------------------------------------------ surface (buildings, slabs, walls)
const TUNE_SURF = {
  bounce: [0.12, 0.112, 0.098],   // linear irradiance of the warm interior bounce (scaled by albedo and texture AO)
};
/**
 * Material for merged static geometry with attributes: position, normal, uv (metres / tile), color (tint, u8 x3),
 * aSurf (layer, ambient occlusion). One instance serves every building, slab and wall in the world.
 */
export function surfaceMaterial(opts = {}) {
  const a = arrays;
  if (!a) throw new Error('[WORLD/materials] buildArrays first');
  const m = new THREE.MeshStandardMaterial({ name: 'zf-surface', vertexColors: true, roughness: 1, metalness: 1, side: opts.side || THREE.FrontSide });
  const uniforms = { ...arrayUniforms(a), uNormalScale: { value: opts.normalScale ?? 1.0 }, tNoise: { value: noiseTexture() }, uBounce: { value: new THREE.Color(TUNE_SURF.bounce[0], TUNE_SURF.bounce[1], TUNE_SURF.bounce[2]) } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSurf;\nvarying vec2 vSurf;\nvarying vec2 vZfUv;\nvarying vec3 vZfW;\nvarying vec3 vZfN;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSurf = aSurf;\nvZfUv = uv;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vec4 zfW4 = vec4( transformed, 1.0 ); vec3 zfN3 = objectNormal;
        #ifdef USE_INSTANCING
          zfW4 = instanceMatrix * zfW4; zfN3 = mat3( instanceMatrix ) * zfN3;
        #endif
        vZfW = ( modelMatrix * zfW4 ).xyz;
        vZfN = normalize( mat3( modelMatrix ) * zfN3 );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;\nvarying vec2 vZfUv;\nvarying vec3 vZfW;\nvarying vec3 vZfN;\nuniform float uNormalScale;\nuniform sampler2D tNoise;\nuniform vec3 uBounce;\n' + GLSL_ARRAYS)
      .replace('#include <map_fragment>', /* glsl */`
        vec3 zfTc = vec3( vZfUv, floor( vSurf.x + 0.5 ) );
        diffuseColor.rgb *= texture( tDiff, zfTc ).rgb * 2.0;   // vertex tints are stored halved (buildings.js TUNE.tintScale)
        // weathering: broad tone drift on every surface, rain streaks and soot on walls (world space, so it never tiles
        // with the material), stronger on outdoor faces than on interior ones (vSurf.y is the sky-light factor)
        vec2 zfWp = abs( vZfN.x ) > abs( vZfN.z ) ? vZfW.zy : vZfW.xy;
        float zfBroad = texture( tNoise, vZfW.xz / 37.0 + zfWp / 53.0 ).y;
        float zfStreak = texture( tNoise, vec2( zfWp.x / 2.3, zfWp.y / 21.0 ) ).z;
        float zfWall = 1.0 - abs( vZfN.y );
        float zfOut = smoothstep( 0.5, 0.95, vSurf.y );
        diffuseColor.rgb *= 0.9 + 0.2 * zfBroad;
        diffuseColor.rgb *= 1.0 - zfWall * zfOut * smoothstep( 0.45, 0.85, zfStreak ) * 0.2;
        vec3 zfArm = texture( tArm, zfTc ).rgb;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * zfArm.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * zfArm.b;')
      .replace('#include <normal_fragment_maps>', /* glsl */`
        vec3 zfMapN = texture( tNor, zfTc ).xyz * 2.0 - 1.0;
        zfMapN.xy *= uNormalScale;
        normal = normalize( zfTangentFrame( - vViewPosition, normal, vZfUv ) * zfMapN );`)
      .replace('#include <aomap_fragment>', AO_CHUNK('mix( 1.0, zfArm.r, 0.8 ) * vSurf.y') + /* glsl */`
        // rooms: warm light bounced in through doors and windows off sunlit ground, so interiors stay readable and
        // do not take the cold blue cast of a sky-only ambient
        reflectedLight.indirectDiffuse += material.diffuseColor * uBounce * ( 1.0 - zfOut ) * mix( 1.0, zfArm.r, 0.6 );`);
  };
  m.customProgramCacheKey = () => 'zf-surface';
  return m;
}

// ------------------------------------------------------------------------------------------ terrain
/**
 * Splat terrain: grass (two sets, anti-tiling at two scales), forest floor, mud, gravel/dirt, sand by height,
 * rock by slope (triplanar). ctrl = RGBA control map over the 1200 m world (dirt, straw, forest, mud).
 */
export function terrainMaterial({ ctrl, ao, worldSize = 1200 }) {
  const a = arrays;
  const m = new THREE.MeshStandardMaterial({ name: 'zf-terrain', roughness: 1, metalness: 0 });
  const uniforms = {
    ...arrayUniforms(a),
    tCtrl: { value: ctrl }, tAO: { value: ao }, tNoise: { value: noiseTexture() },
    uWorld: { value: worldSize },
    uTiles: { value: new THREE.Vector4(TILE[L.sparse_grass], TILE[L.forrest_ground_01], TILE[L.brown_mud_02], TILE[L.gravelly_sand]) },
    uRockTile: { value: 13.0 },
    uSand: { value: new THREE.Vector2(HF.beachHeight - 0.2, HF.beachHeight + 0.6) },
    uRockSlope: { value: 1.0 - HF.rockSlope },
    uAvg: { value: a.avg },
    uQuarry: { value: new THREE.Vector4(quarry.x, quarry.z, quarry.rim + 1, 1.0 - HF.pit.rockNy) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWNrm = normalize( mat3( modelMatrix ) * objectNormal );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_ARRAYS + TERRAIN_PARS)
      .replace('#include <map_fragment>', TERRAIN_SPLAT)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = zfArmS.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( zfNw, 0.0 ) ).xyz );')
      .replace('#include <aomap_fragment>', AO_CHUNK('mix( 1.0, zfArmS.r, 0.9 ) * zfGroundAO'));
  };
  m.customProgramCacheKey = () => 'zf-terrain';
  m.userData.uniforms = uniforms;
  return m;
}

const TERRAIN_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D tCtrl;
uniform sampler2D tAO;
uniform sampler2D tNoise;
float zfGroundAO;
uniform float uWorld;
uniform vec4 uTiles;
uniform float uRockTile;
uniform vec2 uSand;
uniform float uRockSlope;
uniform vec3 uAvg[ 13 ];
uniform vec4 uQuarry;
vec3 zfAlbS; vec3 zfNw; vec3 zfArmS;

float zfLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
// Texture detail relative to the layer mean: the luminance ratio (contrast-scaled) plus a share of its own hue.
// Colour then comes from the macro palette, so the scanned sets' native hue (dry, orange, tan) never dominates.
vec3 zfDet( vec3 c, int layer, float hue, float contrast ) {
  vec3 a = uAvg[ layer ];
  float lr = zfLum( c ) / max( zfLum( a ), 1e-3 );
  vec3 chroma = ( c / max( a, vec3( 1e-3 ) ) ) / max( lr, 1e-3 );
  return mix( 1.0, lr, contrast ) * mix( vec3( 1.0 ), clamp( chroma, 0.0, 3.0 ), hue );
}
vec3 zfPlanarN( vec3 tn, vec3 N ) {
  vec3 T = normalize( vec3( 1.0, 0.0, 0.0 ) - N * N.x );
  vec3 B = normalize( vec3( 0.0, 0.0, 1.0 ) - N * N.z );
  return normalize( T * tn.x + B * tn.y + N * tn.z );
}
void zfLayer( float layer, vec2 uv, float nscale, vec3 N, out vec3 alb, out vec3 nw, out vec3 arm ) {
  vec3 tc = vec3( uv, layer );
  alb = texture( tDiff, tc ).rgb;
  vec3 tn = texture( tNor, tc ).xyz * 2.0 - 1.0;
  tn.xy *= nscale;
  nw = zfPlanarN( tn, N );
  arm = texture( tArm, tc ).rgb;
}
// Height-aware blend: the layer's own AO (crevices low, tops high) sharpens transitions into natural shapes.
float zfHB( float w, float hgt ) {
  return clamp( ( w - ( 1.0 - hgt ) * 0.55 ) * 2.4 + w * 0.15, 0.0, 1.0 );
}
`;

const TERRAIN_SPLAT = /* glsl */`
  vec2 zfP = vWPos.xz;
  float zfDist = length( vWPos - cameraPosition );
  vec4 zfNs = texture( tNoise, zfP / 173.0 );
  vec4 zfNd = texture( tNoise, zfP / 23.0 );
  vec4 zfNb = texture( tNoise, zfP / 690.0 + 0.31 );
  vec2 zfCuv = ( zfP + uWorld * 0.5 ) / uWorld + ( zfNd.xy - 0.5 ) * ( 1.3 / uWorld );
  vec4 zfC = texture( tCtrl, zfCuv );
  zfGroundAO = texture( tAO, ( zfP + uWorld * 0.5 ) / uWorld ).r;
  vec3 zfN0 = normalize( vWNrm );
  float zfNsc = mix( 1.0, 0.35, smoothstep( 25.0, 220.0, zfDist ) );
  float zfH = vWPos.y;
  float zfSlope = 1.0 - zfN0.y;

  // --- grass macro colour: meadow, drier on high sun-facing ground, lush in hollows, mottled at every scale
  float zfDry = smoothstep( 0.46, 0.8, zfNb.x * 0.5 + zfNs.y * 0.42 + smoothstep( 16.0, 46.0, zfH ) * 0.16 + zfSlope * 0.7 - zfC.b * 0.3 );
  float zfLush = smoothstep( 0.52, 0.8, zfNs.z * 0.55 + zfNb.y * 0.45 ) * ( 1.0 - zfDry );
  vec3 cG = mix( vec3( 0.074, 0.104, 0.030 ), vec3( 0.142, 0.132, 0.056 ), zfDry );
  cG = mix( cG, vec3( 0.046, 0.074, 0.020 ), zfLush * 0.85 );
  cG *= 0.88 + 0.24 * zfNd.w;
  cG = mix( cG, vec3( 0.25, 0.20, 0.085 ), zfC.g * 0.85 );

  // --- grass detail: two sets at two scales against tiling
  vec3 aA, nA, rA, aB, nB, rB;
  float zfLeafy = smoothstep( 0.38, 0.68, zfNs.x + ( zfNd.z - 0.5 ) * 0.25 );
  vec2 uvS = zfP / uTiles.x;
  vec2 uvL = mat2( 0.8, -0.6, 0.6, 0.8 ) * zfP / ( uTiles.x * 3.7 );
  zfLayer( 0.0, uvS, zfNsc, zfN0, aA, nA, rA );
  zfLayer( 2.0, uvS * 0.93 + 0.37, zfNsc, zfN0, aB, nB, rB );
  vec3 dG = mix( zfDet( aA, 0, 0.12, 0.85 ), zfDet( aB, 2, 0.12, 0.85 ), zfLeafy );
  vec3 gn1 = normalize( mix( nA, nB, zfLeafy ) ), gr1 = mix( rA, rB, zfLeafy );
  float zfFar = smoothstep( 18.0, 90.0, zfDist );
  if ( zfFar > 0.01 ) {
    zfLayer( 0.0, uvL, zfNsc, zfN0, aA, nA, rA );
    zfLayer( 2.0, uvL * 1.07 + 0.11, zfNsc, zfN0, aB, nB, rB );
    float mixL = mix( 0.5, 0.85, zfFar );
    dG = mix( dG, mix( zfDet( aA, 0, 0.12, 0.85 ), zfDet( aB, 2, 0.12, 0.85 ), zfLeafy ), mixL );
    gn1 = normalize( mix( gn1, normalize( mix( nA, nB, zfLeafy ) ), mixL ) );
    gr1 = mix( gr1, mix( rA, rB, zfLeafy ), mixL );
  }
  vec3 zfAlb = cG * dG; vec3 zfNrm = gn1; vec3 zfArm = vec3( gr1.r, max( gr1.g, 0.82 ), 0.0 );
  vec3 la, ln, lr;

  // --- forest floor: needles and leaf litter, darker under the canopy
  float wF = zfC.b;
  if ( wF > 0.004 ) {
    zfLayer( 2.0, zfP / uTiles.y + 0.5, zfNsc, zfN0, la, ln, lr );
    vec3 aM, nM, rM;
    zfLayer( 3.0, zfP / ( uTiles.z * 1.6 ) + 0.21, zfNsc, zfN0, aM, nM, rM );
    float lit = smoothstep( 0.3, 0.7, zfNd.y );
    la = mix( vec3( 0.062, 0.052, 0.030 ), vec3( 0.075, 0.078, 0.034 ), lit ) * zfDet( la, 2, 0.25, 1.0 );
    la = mix( la, vec3( 0.058, 0.046, 0.032 ) * zfDet( aM, 3, 0.3, 1.0 ), smoothstep( 0.55, 0.8, zfNd.x ) * 0.6 );
    float w = zfHB( wF, lr.r );
    zfAlb = mix( zfAlb, la, w ); zfNrm = normalize( mix( zfNrm, ln, w ) ); zfArm = mix( zfArm, vec3( lr.r, 0.9, 0.0 ), w );
  }
  // --- mud (fields, ruts) plus a few natural damp patches in low meadows
  float wM = max( zfC.a, smoothstep( 0.72, 0.86, zfNd.w ) * smoothstep( 0.55, 0.75, zfNs.z ) * 0.7 * ( 1.0 - zfC.b ) );
  if ( wM > 0.004 ) {
    zfLayer( 3.0, zfP / uTiles.z, zfNsc, zfN0, la, ln, lr );
    la = vec3( 0.068, 0.055, 0.040 ) * zfDet( la, 3, 0.4, 1.0 );
    float w = zfHB( wM, lr.r );
    zfAlb = mix( zfAlb, la, w ); zfNrm = normalize( mix( zfNrm, ln, w ) ); zfArm = mix( zfArm, lr, w );
  }
  // --- gravel / packed dirt (tracks, shoulders, yards, quarry): neutral grey-brown, damp patches toward mud
  float wD = zfC.r;
  if ( wD > 0.004 ) {
    zfLayer( 5.0, zfP / uTiles.w, zfNsc, zfN0, la, ln, lr );
    vec3 mudA, mudN, mudR;
    zfLayer( 3.0, zfP / ( uTiles.z * 1.9 ) + 0.5, zfNsc, zfN0, mudA, mudN, mudR );
    vec3 grav = mix( vec3( 0.150, 0.135, 0.112 ), vec3( 0.185, 0.165, 0.130 ), zfNd.z ) * zfDet( la, 5, 0.1, 1.1 );
    float dm = smoothstep( 0.35, 0.75, zfNd.x );
    la = mix( grav, vec3( 0.070, 0.058, 0.044 ) * zfDet( mudA, 3, 0.3, 1.0 ), dm * 0.45 );
    ln = normalize( mix( ln, mudN, dm * 0.5 ) ); lr = mix( lr, mudR, dm * 0.5 );
    float w = zfHB( wD, lr.r );
    zfAlb = mix( zfAlb, la, w ); zfNrm = normalize( mix( zfNrm, ln, w ) ); zfArm = mix( zfArm, lr, w );
  }
  // --- sand by height above sea level (beaches, seabed): pale and dry above the swash, dark and glossy below
  float wS = 1.0 - smoothstep( uSand.x, uSand.y, zfH + ( zfNd.y - 0.5 ) * 0.6 );
  if ( wS > 0.004 ) {
    zfLayer( 5.0, zfP / ( uTiles.w * 1.4 ), zfNsc * 0.7, zfN0, la, ln, lr );
    la = mix( vec3( 0.34, 0.29, 0.20 ), vec3( 0.40, 0.345, 0.24 ), zfNs.w ) * zfDet( la, 5, 0.08, 0.8 );
    float wet = 1.0 - smoothstep( 0.05, 0.8, zfH );
    la *= mix( 1.0, 0.55, wet ); lr.g *= mix( 1.0, 0.5, wet );
    float w = zfHB( wS, lr.r );
    zfAlb = mix( zfAlb, la, w ); zfNrm = normalize( mix( zfNrm, ln, w ) ); zfArm = mix( zfArm, lr, w );
  }
  // --- rock on slopes: triplanar, grey stone with the scan's luminance detail; inside the quarry every bench face
  float zfQ = 1.0 - smoothstep( uQuarry.z - 2.0, uQuarry.z + 1.0, length( zfP - uQuarry.xy ) );
  float zfRT = mix( uRockSlope, uQuarry.w, zfQ );
  float wR = smoothstep( zfRT - 0.07, zfRT + 0.06, zfSlope + ( zfNs.z - 0.5 ) * 0.1 );
  if ( wR > 0.004 ) {
    vec3 bw = pow( abs( zfN0 ), vec3( 4.0 ) ); bw /= ( bw.x + bw.y + bw.z );
    vec3 p = vWPos / uRockTile;
    vec3 ax = texture( tDiff, vec3( p.zy, 4.0 ) ).rgb, ay = texture( tDiff, vec3( p.xz, 4.0 ) ).rgb, az = texture( tDiff, vec3( p.xy, 4.0 ) ).rgb;
    vec3 tx = texture( tNor, vec3( p.zy, 4.0 ) ).xyz * 2.0 - 1.0, ty = texture( tNor, vec3( p.xz, 4.0 ) ).xyz * 2.0 - 1.0, tz = texture( tNor, vec3( p.xy, 4.0 ) ).xyz * 2.0 - 1.0;
    vec3 rx = texture( tArm, vec3( p.zy, 4.0 ) ).rgb, ry = texture( tArm, vec3( p.xz, 4.0 ) ).rgb, rz = texture( tArm, vec3( p.xy, 4.0 ) ).rgb;
    la = ax * bw.x + ay * bw.y + az * bw.z;
    lr = rx * bw.x + ry * bw.y + rz * bw.z;
    vec3 nX = vec3( 0.0, tx.y, tx.x ) * sign( zfN0.x ), nY = vec3( ty.x, 0.0, ty.y ), nZ = vec3( tz.x, tz.y, 0.0 );
    ln = normalize( zfN0 + ( nX * bw.x + nY * bw.y + nZ * bw.z ) * 1.2 * zfNsc );
    // the scan's average is mostly grass, so map its luminance onto a stone ramp instead of a ratio to that mean
    float rl = smoothstep( 0.015, 0.32, zfLum( la ) );
    la = mix( vec3( 0.050, 0.048, 0.044 ), mix( vec3( 0.17, 0.162, 0.148 ), vec3( 0.215, 0.20, 0.178 ), zfNs.x ), rl );
    lr.g = max( lr.g, 0.75 );
    // blasted benches: pale limestone with horizontal strata
    float strata = texture( tNoise, vec2( zfP.x / 41.0 + zfP.y / 37.0, zfH / 2.3 ) ).x;
    la = mix( la, la * vec3( 1.25, 1.22, 1.15 ) * ( 0.8 + 0.4 * strata ), zfQ );
    float w = zfHB( wR, lr.r );
    zfAlb = mix( zfAlb, la, w ); zfNrm = normalize( mix( zfNrm, ln, w ) ); zfArm = mix( zfArm, lr, w );
  }
  // underwater: darker, bluer seabed (the water surface adds the rest)
  float zfUw = 1.0 - smoothstep( -1.5, 0.05, zfH );
  zfAlb *= mix( vec3( 1.0 ), vec3( 0.55, 0.7, 0.72 ), zfUw );
  // contact occlusion also eats a little bounce light from the albedo (no GI under eaves and canopies)
  zfAlb *= mix( 0.78, 1.0, zfGroundAO );
  zfAlbS = zfAlb; zfNw = zfNrm; zfArmS = zfArm;
  diffuseColor.rgb *= zfAlbS;
`;

// ------------------------------------------------------------------------------------------ road ribbons
/**
 * Asphalt road ribbons: attributes position, normal, aRoad (lateral offset m, arc length m, half width, marking
 * fade). Procedural lane markings (white edges, dashed centre), tyre polish lanes, edge grime and patch repairs.
 */
export function roadMaterial() {
  const a = arrays;
  const m = new THREE.MeshStandardMaterial({ name: 'zf-road', roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const uniforms = { ...arrayUniforms(a), tNoise: { value: noiseTexture() }, uTile: { value: TILE[L.asphalt_02] } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nvarying vec4 vRoad;\nvarying vec3 vRW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvRoad = aRoad;\nvRW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRoad;\nvarying vec3 vRW;\nuniform sampler2D tNoise;\nuniform float uTile;\n' + GLSL_ARRAYS)
      .replace('#include <map_fragment>', /* glsl */`
        float lat = vRoad.x, sAl = vRoad.y, hw = vRoad.z, fade = vRoad.w;
        vec2 ruv = vec2( lat, sAl ) / uTile;
        vec3 zfTc = vec3( ruv, 6.0 );
        vec3 alb = texture( tDiff, zfTc ).rgb;
        vec3 zfArm = texture( tArm, zfTc ).rgb;
        vec4 nz = texture( tNoise, vRW.xz / 31.0 );
        vec4 nf = texture( tNoise, vRW.xz / 4.3 );
        // repaired patches: darker, smoother rectangles of newer asphalt
        float patchy = step( 0.74, nz.x ) * step( abs( lat ), hw - 0.6 );
        alb *= mix( 1.0, 0.72, patchy );
        // polished tyre lanes, grime toward the edges
        float lane = exp( -pow( ( abs( lat ) - hw * 0.5 ) / 0.45, 2.0 ) );
        alb *= mix( 1.0, 0.86, lane * 0.6 );
        zfArm.g *= mix( 1.0, 0.8, lane );
        float edge = smoothstep( hw - 0.9, hw, abs( lat ) );
        alb = mix( alb, alb * vec3( 0.86, 0.82, 0.74 ) + vec3( 0.03, 0.025, 0.015 ), edge * 0.6 );
        // markings: solid edge lines, dashed centre line, worn by noise
        float wear = smoothstep( 0.25, 0.65, nf.y + nz.w * 0.3 );
        float edgeLine = 1.0 - smoothstep( 0.06, 0.09, abs( abs( lat ) - ( hw - 0.35 ) ) );
        float dash = step( fract( sAl / 9.0 ), 0.38 );
        float centre = ( 1.0 - smoothstep( 0.05, 0.08, abs( lat ) ) ) * dash;
        float paint = max( edgeLine, centre ) * fade * wear;
        alb = mix( alb, vec3( 0.78, 0.77, 0.72 ), paint * 0.92 );
        zfArm.g = mix( zfArm.g, 0.55, paint );
        diffuseColor.rgb *= alb;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = zfArm.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', /* glsl */`
        vec3 zfMapN = texture( tNor, zfTc ).xyz * 2.0 - 1.0;
        zfMapN.xy *= 0.8;
        normal = normalize( zfTangentFrame( - vViewPosition, normal, ruv ) * zfMapN );`)
      .replace('#include <aomap_fragment>', AO_CHUNK('mix( 1.0, zfArm.r, 0.8 )'));
  };
  m.customProgramCacheKey = () => 'zf-road';
  return m;
}
