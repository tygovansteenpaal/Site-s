// ZONEFALL - ocean. OWNER: WORLD (internal).
// A flat surface at sea level (physics agrees with what you see) that follows the camera out to the fog limit.
// Waves are shading only: three scrolling layers of a generated tileable normal map plus a broad swell, so there
// is no water texture to ship. Colour and opacity come from the water depth (a small texture baked from the
// terrain grid): turquoise over sand, deep blue-green offshore, a foam line that washes up and down the beach,
// HDRI reflections with Fresnel (reflections stay visible where the water is clear) and a sharp sun glint.
import * as THREE from 'three';
import { MAP } from '../core/mapdata.js';
import { RENDER } from '../config.js';
import { gridHeight } from './terrain.js';

const TUNE = {
  depthTexSize: 512,
  shallow: new THREE.Color(0.055, 0.30, 0.29),
  deep: new THREE.Color(0.010, 0.055, 0.075),
  roughness: 0.055,
  snap: 50,
};

let mesh = null, mat = null;
const uniforms = { uTime: { value: 0 }, tWaveN: { value: null }, tDepth: { value: null }, uWorld: { value: MAP.size } };

function waveNormalTexture() {
  const S = 256;
  const h = new Float32Array(S * S);
  // sum of periodic sinusoid trains in several directions: tileable by construction (integer wave numbers)
  const waves = [[3, 1, 1.0], [-2, 3, 0.8], [5, -2, 0.5], [1, 6, 0.42], [-7, -3, 0.3], [9, 4, 0.22], [-4, 11, 0.16], [13, -7, 0.12], [-15, 9, 0.08], [17, 14, 0.06]];
  let s = 4242;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const phases = waves.map(() => rnd() * Math.PI * 2);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    waves.forEach(([kx, ky, a], i) => { const p = (kx * x + ky * y) / S * Math.PI * 2 + phases[i]; v += a * Math.pow(0.5 + 0.5 * Math.sin(p), 1.6); });
    h[y * S + x] = v;
  }
  const data = new Uint8Array(S * S * 4);
  const k = 3.2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    let nx = -dx * k, ny = -dy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * S + x) * 4;
    data[o] = (nx * 0.5 + 0.5) * 255; data[o + 1] = (ny * 0.5 + 0.5) * 255; data[o + 2] = (nz * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function depthTexture() {
  const S = TUNE.depthTexSize, half = MAP.half, W = MAP.size;
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    const z = -half + (j + 0.5) * (W / S);
    for (let i = 0; i < S; i++) {
      const h = gridHeight(-half + (i + 0.5) * (W / S), z);
      const o = (j * S + i) * 4;
      data[o] = Math.min(1, Math.max(0, -h / 14)) * 255;   // depth below sea level
      data[o + 1] = Math.min(1, Math.max(0, h / 4)) * 255;  // height above (shore)
      data[o + 2] = 0; data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const WATER_PARS = /* glsl */`
varying vec3 vWPos;
uniform float uTime;
uniform sampler2D tWaveN;
uniform sampler2D tDepth;
uniform float uWorld;
uniform vec3 uShallow;
uniform vec3 uDeep;
float zfDepth; float zfFoam;
vec3 zfWaveN( vec2 p, float dist ) {
  vec3 n1 = texture2D( tWaveN, p / 23.0 + vec2( uTime * 0.021, uTime * 0.013 ) ).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D( tWaveN, p / 9.1 * mat2( 0.8, 0.6, -0.6, 0.8 ) - vec2( uTime * 0.034, -uTime * 0.027 ) ).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D( tWaveN, p / 3.3 + vec2( -uTime * 0.06, uTime * 0.045 ) ).xyz * 2.0 - 1.0;
  vec3 sw = texture2D( tWaveN, p / 140.0 + vec2( uTime * 0.006, 0.0 ) ).xyz * 2.0 - 1.0;
  float fine = 1.0 - smoothstep( 40.0, 260.0, dist );
  vec2 xy = n1.xy * 0.55 + n2.xy * 0.45 * ( 0.4 + 0.6 * fine ) + n3.xy * 0.35 * fine + sw.xy * 0.6;
  xy *= mix( 1.0, 0.45, smoothstep( 120.0, 900.0, dist ) );
  return normalize( vec3( xy.x, 1.0, xy.y ) );
}
`;

/**
 * @param {THREE.Scene} scene
 * @param {object} quality
 */
export function buildWater(scene, quality) {
  uniforms.tWaveN.value = waveNormalTexture();
  uniforms.tDepth.value = depthTexture();
  uniforms.uShallow = { value: TUNE.shallow };
  uniforms.uDeep = { value: TUNE.deep };
  uniforms.uEdge = { value: RENDER.far };
  mat = new THREE.MeshStandardMaterial({ name: 'zf-water', color: 0xffffff, roughness: TUNE.roughness, metalness: 0, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uEdge;\n' + WATER_PARS)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 duv = ( vWPos.xz + uWorld * 0.5 ) / uWorld;
        vec4 dz = texture2D( tDepth, duv );
        bool inside = duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0;
        zfDepth = inside ? dz.r * 14.0 - dz.g * 2.0 : 14.0;
        float wDist = length( vWPos - cameraPosition );
        float wash = sin( uTime * 0.9 + vWPos.x * 0.05 + vWPos.z * 0.04 ) * 0.25;
        vec3 wn = texture2D( tWaveN, vWPos.xz / 5.0 + uTime * 0.03 ).xyz;
        float fnoise = wn.x * 0.6 + texture2D( tWaveN, vWPos.xz / 1.7 - uTime * 0.05 ).y * 0.4;
        zfFoam = ( 1.0 - smoothstep( 0.0, 0.55 + wash, zfDepth ) ) * smoothstep( 0.42, 0.62, fnoise + ( 1.0 - smoothstep( 0.0, 0.25, zfDepth ) ) * 0.35 );
        vec3 wc = mix( uShallow, uDeep, smoothstep( 0.2, 9.0, zfDepth ) );
        diffuseColor.rgb = mix( wc, vec3( 0.92, 0.95, 0.95 ), zfFoam );
        diffuseColor.a = mix( 0.42, 0.985, smoothstep( 0.0, 5.0, zfDepth ) );
        diffuseColor.a = max( diffuseColor.a, zfFoam * 0.95 );`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( roughness, 0.7, zfFoam );')
      .replace('#include <normal_fragment_maps>', /* glsl */`
        vec3 zfNw = zfWaveN( vWPos.xz, length( vWPos - cameraPosition ) );
        zfNw = normalize( mix( zfNw, vec3( 0.0, 1.0, 0.0 ), zfFoam * 0.6 ) );
        normal = normalize( ( viewMatrix * vec4( zfNw, 0.0 ) ).xyz );`)
      .replace('#include <opaque_fragment>', /* glsl */`
        #include <opaque_fragment>
        float zfFres = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 5.0 );
        gl_FragColor.a = mix( gl_FragColor.a, 1.0, zfFres * 0.9 );`)
      .replace('#include <fog_fragment>', /* glsl */`
        #include <fog_fragment>
        #ifdef USE_FOG
          // the plane ends before the true horizon: fade its far edge fully into the fog colour the sky dome uses
          float zfEdge = smoothstep( uEdge * 0.45, uEdge * 0.92, max( length( vWPos.xz - cameraPosition.xz ), vFogDepth ) );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, zfgFogCol, zfEdge );
          gl_FragColor.a = mix( gl_FragColor.a, 1.0, zfEdge );
        #endif`);
  };
  mat.customProgramCacheKey = () => 'zf-water';
  const size = RENDER.far * 2;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
  mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ocean';
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return mesh;
}

/** Follow the view (snapped) and advance the wave time. */
export function updateWater(dt, viewPos) {
  if (!mesh) return;
  uniforms.uTime.value += dt;
  mesh.position.set(Math.round(viewPos.x / TUNE.snap) * TUNE.snap, MAP.seaLevel, Math.round(viewPos.z / TUNE.snap) * TUNE.snap);
}
