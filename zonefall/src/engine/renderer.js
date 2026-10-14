// ZONEFALL - renderer, post chain, quality tiers. OWNER: WORLD. Contract: ARCHITECTURE.md 5.1
// WebGLRenderer (no MSAA; AA comes from SMAA in post), sRGB output, ACES, PCF shadows, DPR capped per tier plus a
// 2560x1440 pixel cap, adaptive DPR, and on medium/high a pmndrs post chain in HalfFloat buffers:
//   world RenderPass -> [ground AO (high)] -> overlay RenderPass (viewmodel, depth cleared) ->
//   EffectPass(bloom, grade = exposure + ACES + filmic grade, vignette, grain) -> EffectPass(SMAA)
// The fog shader chunks are replaced by an atmospheric fog: exp2 density integrated over a height falloff (the
// island stays readable from the plane) with forward scattering toward the sun. Same uniforms as THREE.FogExp2.
import * as THREE from 'three';
import { QUALITY, QUALITY_NAMES, RENDER, DEV } from '../config.js';
import { emit, on, EV } from '../core/bus.js';
import { state, gfx, debug } from '../core/state.js';
import * as settings from '../core/settings.js';

const TUNE = {
  maxPixels: 2560 * 1440,
  slowMs: 22, slowHold: 2.0,      // average above this for slowHold s -> step DPR down
  fastMs: 13, fastHold: 5.0,      // average below this for fastHold s -> step DPR up
  dprStep: 0.1,
  bloom: { threshold: 1.0, smoothing: 0.12, intensity: 0.55, radius: 0.72 },
  vignette: { offset: 0.32, darkness: 0.42 },
  grain: 0.045,
  fogScaleHeight: 210,             // m; fog density halves roughly every 145 m of altitude
  fogScatter: 0.55,                // strength of the warm forward-scatter lobe toward the sun
  ao: { radius: 1.6, intensity: 0.85, samples: 12 },
};

let renderer = null, scene = null, camera = null, canvas = null;
let tierName = 'medium';
let q = QUALITY.medium;
let overlay = null, overlayCam = null;
let pp = null;                 // postprocessing module namespace once loaded
let chain = null;              // {composer, renderPass, aoPass, overlayPass, effectPass, smaaPass, grade}
let postWanted = false;
let dpr = 1, dprTarget = 1;
let adaptive = true;
let slowT = 0, fastT = 0, avgMs = 16.7;
let fpsAvg = 60;
let exposure = RENDER.exposure;
let lastStats = { fps: 0, ms: 0, calls: 0, tris: 0, dpr: 1, tier: 'medium' };
let sizeW = 0, sizeH = 0;

function err(msg) { return new Error(`[WORLD/renderer] ${msg}`); }

// ------------------------------------------------------------------------------------------ atmosphere (fog chunks)
const fogState = { sun: new THREE.Vector3(...RENDER.sunDir).normalize(), scatter: new THREE.Color(1.0, 0.86, 0.66) };

function writeFogChunks() {
  const s = fogState.sun, c = fogState.scatter;
  const f = (v) => v.toFixed(5);
  THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogRay;\n#endif';
  THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogRay = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;\n#endif';
  THREE.ShaderChunk.fog_pars_fragment = [
    '#ifdef USE_FOG',
    '\tuniform vec3 fogColor;',
    '\tvarying float vFogDepth;',
    '\tvarying vec3 vFogRay;',
    '\t#ifdef FOG_EXP2',
    '\t\tuniform float fogDensity;',
    '\t#else',
    '\t\tuniform float fogNear;',
    '\t\tuniform float fogFar;',
    '\t#endif',
    `\tconst vec3 zfSunDir = vec3( ${f(s.x)}, ${f(s.y)}, ${f(s.z)} );`,
    `\tconst vec3 zfScatter = vec3( ${f(c.r)}, ${f(c.g)}, ${f(c.b)} );`,
    `\tconst float zfFogK = ${f(1 / TUNE.fogScaleHeight)};`,
    '#endif',
  ].join('\n');
  THREE.ShaderChunk.fog_fragment = [
    '#ifdef USE_FOG',
    '\tfloat zfgDist = length( vFogRay );',
    '\tvec3 zfgDir = vFogRay / max( zfgDist, 1e-4 );',
    '\t#ifdef FOG_EXP2',
    '\t\tfloat zfgH0 = max( cameraPosition.y, 0.0 );',
    '\t\tfloat zfgH1 = max( cameraPosition.y + vFogRay.y, 0.0 );',
    '\t\tfloat zfgDh = zfgH1 - zfgH0;',
    '\t\tfloat zfgA = exp( - zfFogK * zfgH0 );',
    '\t\tfloat zfgAvg = abs( zfgDh ) < 0.5 ? zfgA : ( zfgA - exp( - zfFogK * zfgH1 ) ) / ( zfFogK * zfgDh );',
    '\t\tfloat zfgTau = fogDensity * zfgAvg * vFogDepth;',
    '\t\tfloat fogFactor = 1.0 - exp( - zfgTau * zfgTau );',
    '\t#else',
    '\t\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
    '\t#endif',
    '\tfloat zfgSun = pow( max( dot( zfgDir, zfSunDir ), 0.0 ), 6.0 );',
    '\tfloat zfgAway = 1.0 - max( dot( zfgDir, zfSunDir ), 0.0 );',
    `\tvec3 zfgFogCol = fogColor * mix( vec3( 1.0 ), vec3( 0.93, 0.98, 1.07 ), zfgAway * zfgAway );`,
    `\tzfgFogCol = mix( zfgFogCol, fogColor * zfScatter * 1.35, zfgSun * ${f(TUNE.fogScatter)} );`,
    '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, zfgFogCol, fogFactor );',
    '#endif',
  ].join('\n');
}

/**
 * Atmosphere constants baked into the fog chunks (call before materials compile; the sky module does this at build).
 * @param {{sunDir?: number[], scatter?: number}} opts  sunDir [x,y,z] toward the sun; scatter colour hex
 */
export function setAtmosphere({ sunDir, scatter } = {}) {
  if (sunDir) fogState.sun.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
  if (scatter != null) fogState.scatter.set(scatter);
  writeFogChunks();
}

// ------------------------------------------------------------------------------------------ init and sizing
/**
 * Create renderer, scene and camera; fill gfx.renderer/scene/camera/canvas; pick and apply the quality tier.
 * @param {HTMLCanvasElement} cv
 * @param {{tier?: 'auto'|'low'|'medium'|'high'}} [opts]  'auto' -> detectTier(); DEV.quality overrides
 */
export async function init(cv, opts = {}) {
  if (renderer) throw err('init called twice');
  if (!cv) throw err('init needs a canvas');
  canvas = cv;
  writeFogChunks();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false, depth: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x9fb2c2, 1);

  scene = new THREE.Scene();
  scene.name = 'world';
  camera = new THREE.PerspectiveCamera(70, 16 / 9, RENDER.near, RENDER.far);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 120, 300);
  scene.add(camera);

  gfx.renderer = renderer; gfx.scene = scene; gfx.camera = camera; gfx.canvas = canvas;

  let tier = DEV.quality && QUALITY[DEV.quality] ? DEV.quality : (opts.tier || 'auto');
  if (!QUALITY[tier]) tier = detectTier();
  postWanted = QUALITY[tier].post && !DEV.noPost;
  if (postWanted) await loadPost();
  applyQuality(tier);
  resize();
  addEventListener('resize', resize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);

  on(EV.SETTINGS_CHANGED, ({ key, value }) => {
    if (key !== 'quality' || DEV.quality) return;
    applyQuality(value === 'auto' ? detectTier() : value);
  });
  debug.world = debug.world || {};
  debug.world.renderer = { setAdaptive, stats, get chain() { return chain; } };
  return { renderer, scene, camera };
}

function computeSize() {
  const w = Math.max(1, Math.floor(canvas.clientWidth || innerWidth));
  const h = Math.max(1, Math.floor(canvas.clientHeight || innerHeight));
  return [w, h];
}

function applyDpr() {
  const [w, h] = computeSize();
  let d = Math.min(devicePixelRatio || 1, dprTarget);
  if (w * h * d * d > TUNE.maxPixels) d = Math.sqrt(TUNE.maxPixels / (w * h));
  d = Math.max(0.5, d);
  if (d === dpr && w === sizeW && h === sizeH) return;
  dpr = d; sizeW = w; sizeH = h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (overlayCam && overlayCam.isPerspectiveCamera) { overlayCam.aspect = w / h; overlayCam.updateProjectionMatrix(); }
  if (chain) chain.composer.setSize(w, h, false);
}

function resize() {
  if (!renderer) return;
  sizeW = 0;                 // force
  applyDpr();
}

// ------------------------------------------------------------------------------------------ tiers
let probeCtx = null;
/** Guess a tier from WEBGL_debug_renderer_info + device. */
export function detectTier() {
  let gl = renderer ? renderer.getContext() : null;
  if (!gl) {
    if (!probeCtx) probeCtx = document.createElement('canvas').getContext('webgl2');
    gl = probeCtx;
  }
  if (!gl) return 'low';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(ua));
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/.test(name)) return 'low';
  if (mobile) return 'low';
  if (/apple m\d|apple gpu/.test(name)) return 'high';
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d|radeon \d{3,4}m?\b/.test(name)) return 'high';
  if (/intel|uhd|iris|hd graphics|radeon\(tm\)|vega|adreno|mali|powervr/.test(name)) return 'medium';
  return 'medium';
}

/** Apply QUALITY[tier]. Sets state.quality and emits QUALITY_CHANGED {tier}. */
export function applyQuality(tier) {
  if (!QUALITY[tier]) throw err(`unknown quality tier '${tier}' (use ${QUALITY_NAMES.join(', ')})`);
  tierName = tier;
  q = QUALITY[tier];
  state.quality = tier;
  dprTarget = q.dprCap;
  postWanted = q.post && !DEV.noPost;
  if (renderer) {
    if (postWanted && !pp) {
      loadPost().then(() => { if (postWanted) buildChain(); }).catch((e) => console.error(e));
    } else if (postWanted) buildChain();
    else disposeChain();
    renderer.toneMapping = chain ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    sizeW = 0;
    applyDpr();
  }
  emit(EV.QUALITY_CHANGED, { tier });
}

/** The active QUALITY entry (object from config.QUALITY). */
export function getQuality() { return q; }

// ------------------------------------------------------------------------------------------ post chain
async function loadPost() {
  if (pp) return pp;
  pp = await import('postprocessing');
  return pp;
}

function makeGradeEffect() {
  const { Effect } = pp;
  const frag = /* glsl */`
    uniform float uExposure;
    uniform vec3 uLift;
    uniform vec3 uGain;
    uniform float uSaturation;
    vec3 zfAces( vec3 color ) {
      const mat3 ACESInputMat = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
      const mat3 ACESOutputMat = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
      color *= uExposure / 0.6;
      color = ACESInputMat * color;
      vec3 a = color * ( color + 0.0245786 ) - 0.000090537;
      vec3 b = color * ( 0.983729 * color + 0.4329510 ) + 0.238081;
      color = ACESOutputMat * ( a / b );
      return clamp( color, 0.0, 1.0 );
    }
    void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
      vec3 c = zfAces( inputColor.rgb );
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSaturation );
      c = c * uGain + uLift * ( 1.0 - c );
      outputColor = vec4( clamp( c, 0.0, 1.0 ), inputColor.a );
    }`;
  class GradeEffect extends Effect {
    constructor() {
      super('ZFGradeEffect', frag, {
        uniforms: new Map([
          ['uExposure', new THREE.Uniform(exposure)],
          ['uLift', new THREE.Uniform(new THREE.Vector3(0.012, 0.010, 0.016))],
          ['uGain', new THREE.Uniform(new THREE.Vector3(1.02, 1.0, 0.97))],
          ['uSaturation', new THREE.Uniform(1.06)],
        ]),
      });
    }
  }
  return new GradeEffect();
}

function makeAOEffect() {
  const { Effect, EffectAttribute, BlendFunction } = pp;
  const frag = /* glsl */`
    uniform mat4 uProjInv;
    uniform float uRadius;
    uniform float uIntensity;
    uniform float uProjScale;
    vec3 zfViewPos( vec2 p, float d ) {
      vec4 c = vec4( p * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
      vec4 v = uProjInv * c;
      return v.xyz / v.w;
    }
    float zfHash( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
    void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
      if ( depth >= 0.99999 ) { outputColor = inputColor; return; }
      vec3 P = zfViewPos( uv, depth );
      vec2 dx = vec2( texelSize.x, 0.0 ), dy = vec2( 0.0, texelSize.y );
      vec3 Px = zfViewPos( uv + dx, readDepth( uv + dx ) );
      vec3 Py = zfViewPos( uv + dy, readDepth( uv + dy ) );
      vec3 N = normalize( cross( Px - P, Py - P ) );
      float rad = uRadius * uProjScale / max( -P.z, 0.1 );
      rad = min( rad, 0.12 );
      float phi = zfHash( gl_FragCoord.xy ) * 6.2831853;
      float occ = 0.0;
      const int S = ${TUNE.ao.samples};
      for ( int i = 0; i < S; i ++ ) {
        float fi = ( float( i ) + 0.5 ) / float( S );
        float a = float( i ) * 2.39996 + phi;
        vec2 o = vec2( cos( a ), sin( a ) * aspect ) * rad * sqrt( fi );
        vec2 suv = uv + o;
        float sd = readDepth( suv );
        vec3 Q = zfViewPos( suv, sd );
        vec3 v = Q - P;
        float vv = dot( v, v );
        float vn = dot( v, N );
        float r2 = uRadius * uRadius;
        float f = max( r2 - vv, 0.0 ) / r2;
        occ += f * max( vn / sqrt( vv + 1e-4 ) - 0.08, 0.0 );
      }
      occ = clamp( occ / float( S ) * 2.4, 0.0, 1.0 );
      float fade = smoothstep( 160.0, 60.0, -P.z );
      float ao = 1.0 - occ * uIntensity * fade;
      outputColor = vec4( inputColor.rgb * ao, inputColor.a );
    }`;
  class AOEffect extends Effect {
    constructor() {
      super('ZFGroundAO', frag, {
        attributes: EffectAttribute.DEPTH,
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map([
          ['uProjInv', new THREE.Uniform(new THREE.Matrix4())],
          ['uRadius', new THREE.Uniform(TUNE.ao.radius)],
          ['uIntensity', new THREE.Uniform(TUNE.ao.intensity)],
          ['uProjScale', new THREE.Uniform(1)],
        ]),
      });
    }
    update() {
      this.uniforms.get('uProjInv').value.copy(camera.projectionMatrixInverse);
      this.uniforms.get('uProjScale').value = camera.projectionMatrix.elements[5] * 0.5;
    }
  }
  return new AOEffect();
}

function disposeChain() {
  if (!chain) return;
  chain.composer.dispose();
  chain = null;
  if (renderer) renderer.toneMapping = THREE.ACESFilmicToneMapping;
}

function buildChain() {
  if (!pp || !renderer) return;
  disposeChain();
  const { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, VignetteEffect, NoiseEffect, BlendFunction } = pp;
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0, stencilBuffer: false });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  let aoPass = null;
  if (q.ao) {
    aoPass = new EffectPass(camera, makeAOEffect());
    composer.addPass(aoPass);
  }
  let overlayPass = null;
  if (overlay && overlayCam) {
    overlayPass = new RenderPass(overlay, overlayCam);
    overlayPass.clearPass.setClearFlags(false, true, false);
    overlayPass.ignoreBackground = true;
    overlayPass.skipShadowMapUpdate = true;
    composer.addPass(overlayPass);
  }
  const effects = [];
  if (q.bloom) {
    effects.push(new BloomEffect({ mipmapBlur: true, luminanceThreshold: TUNE.bloom.threshold, luminanceSmoothing: TUNE.bloom.smoothing,
      intensity: TUNE.bloom.intensity, radius: TUNE.bloom.radius }));
  }
  const grade = makeGradeEffect();
  effects.push(grade);
  effects.push(new VignetteEffect({ offset: TUNE.vignette.offset, darkness: TUNE.vignette.darkness }));
  const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SOFT_LIGHT });
  noise.blendMode.opacity.value = TUNE.grain;
  effects.push(noise);
  const effectPass = new EffectPass(camera, ...effects);
  composer.addPass(effectPass);
  let smaaPass = null;
  if (q.smaa) {
    smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
    composer.addPass(smaaPass);
  }
  chain = { composer, renderPass, aoPass, overlayPass, effectPass, smaaPass, grade };
  renderer.toneMapping = THREE.NoToneMapping;
  const [w, h] = computeSize();
  composer.setSize(w, h, false);
}

// ------------------------------------------------------------------------------------------ overlay
/**
 * Register the first-person overlay (viewmodel) scene, rendered after the world with the depth buffer cleared so post
 * effects apply to it. scene.environment follows the world environment. Pass null to remove.
 */
export function setOverlay(ovScene, ovCamera) {
  overlay = ovScene || null;
  overlayCam = overlay ? (ovCamera || camera) : null;
  if (overlayCam && overlayCam.isPerspectiveCamera && sizeW) { overlayCam.aspect = sizeW / sizeH; overlayCam.updateProjectionMatrix(); }
  if (chain) buildChain();
}

function syncOverlayEnv() {
  if (!overlay) return;
  overlay.environment = scene.environment;
  overlay.environmentIntensity = scene.environmentIntensity;
  if (overlay.environmentRotation && scene.environmentRotation) overlay.environmentRotation.copy(scene.environmentRotation);
}

// ------------------------------------------------------------------------------------------ frame
function adapt(dt) {
  const ms = dt * 1000;
  avgMs += (ms - avgMs) * (1 - Math.exp(-dt * 3));
  fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * (1 - Math.exp(-dt * 2));
  if (!adaptive) return;
  if (avgMs > TUNE.slowMs) { slowT += dt; fastT = 0; } else if (avgMs < TUNE.fastMs) { fastT += dt; slowT = 0; } else { slowT = 0; fastT = 0; }
  if (slowT > TUNE.slowHold && dprTarget > q.dprMin + 1e-3) {
    dprTarget = Math.max(q.dprMin, dprTarget - TUNE.dprStep); slowT = 0; applyDpr();
  } else if (fastT > TUNE.fastHold && dprTarget < q.dprCap - 1e-3) {
    dprTarget = Math.min(q.dprCap, dprTarget + TUNE.dprStep); fastT = 0; applyDpr();
  }
}

/** Render one frame (composer or plain renderer). Also runs the adaptive-DPR controller. */
export function render(dt = 1 / 60) {
  if (!renderer) throw err('render before init');
  adapt(dt);
  renderer.info.reset();
  syncOverlayEnv();
  if (chain) {
    chain.composer.render(dt);
  } else {
    renderer.autoClear = true;
    renderer.render(scene, camera);
    if (overlay && overlayCam) {
      renderer.autoClear = false;
      renderer.clearDepth();
      const sm = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.render(overlay, overlayCam);
      renderer.shadowMap.autoUpdate = sm;
      renderer.autoClear = true;
    }
  }
  lastStats.calls = renderer.info.render.calls;
  lastStats.tris = renderer.info.render.triangles;
}

/** Precompile all shaders of scene + overlay so the first frames do not hitch. */
export async function compile() {
  if (!renderer) throw err('compile before init');
  await renderer.compileAsync(scene, camera);
  if (overlay && overlayCam) await renderer.compileAsync(overlay, overlayCam, scene);
}

/** @returns {{fps:number, ms:number, calls:number, tris:number, dpr:number, tier:string}} */
export function stats() {
  lastStats.fps = Math.round(fpsAvg);
  lastStats.ms = Math.round(avgMs * 10) / 10;
  lastStats.dpr = Math.round(dpr * 100) / 100;
  lastStats.tier = tierName;
  return { ...lastStats };
}

/** Tone-mapping exposure (zone interior, menu). */
export function setExposure(v) {
  exposure = Math.max(0.05, Number(v) || 1);
  if (renderer) renderer.toneMappingExposure = exposure;
  if (chain && chain.grade) chain.grade.uniforms.get('uExposure').value = exposure;
}

/** Enable or disable the adaptive DPR controller (tests pin the DPR). */
export function setAdaptive(on) {
  adaptive = !!on;
  if (!adaptive) { dprTarget = q.dprCap; applyDpr(); }
}

/** Current settings quality preference resolved to a tier name. */
export function resolveTierSetting() {
  const s = settings.get('quality');
  return s === 'auto' ? detectTier() : s;
}
