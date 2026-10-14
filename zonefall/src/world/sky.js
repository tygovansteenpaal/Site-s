// ZONEFALL - sky, image-based light, sun, shadows and fog. OWNER: WORLD (internal).
// The pure-sky HDRI is prepared before PMREM: rotated about Y so its sun sits at the configured azimuth, the sun
// disc clamped (the DirectionalLight carries that energy, so it is not counted twice), and the empty lower
// hemisphere replaced by a ground-bounce colour so undersides are not lit by a mirrored sky. The visible sky is a
// dome shader over the 4k background JPG with horizon haze that matches the fog colour exactly, so terrain fades
// into the sky at any altitude. One shadow-casting sun follows the view with a texel-snapped fitted frustum.
import * as THREE from 'three';
import { RENDER, QUALITY } from '../config.js';
import { on, EV } from '../core/bus.js';
import { gfx } from '../core/state.js';
import * as assets from '../engine/assets.js';
import * as renderer from '../engine/renderer.js';
import { heightAt } from './heightfield.js';

const TUNE = {
  sunClamp: 22,                 // max luminance kept in the env map (linear)
  groundAlbedo: [0.34, 0.33, 0.24],
  skyIntensity: 1.0,            // background JPG multiplier (linear)
  horizonElevDeg: 1.5,
  hazeFalloff: 15.0,
  hazeAmount: 0.56,
  fogScale: 0.8,                // x QUALITY.fogDensity (the fog chunk also thins it with altitude)
  shadowDistance: 320,          // light distance from the shadow centre
  shadowBias: -0.00035,
  shadowNormalBias: 0.035,
  shadowRadius: 2.6,
  shadowLead: 0.42,             // push the shadow box forward along the view (x range)
  sunColor: 0xfff1de,
};

let sun = null, target = null, dome = null, domeMat = null;
let sunDir = new THREE.Vector3(...RENDER.sunDir).normalize();
let horizon = new THREE.Color(RENDER.fogColor);
let range = 50, mapSize = 1024;
let envRT = null;
let qual = QUALITY.medium;

/** World-space direction to the sun [x, y, z]. */
export function sunDirection() { return [sunDir.x, sunDir.y, sunDir.z]; }
export const sunVector = () => sunDir;
export const horizonColor = () => horizon;
export const getSun = () => sun;
/** Half extent (m) of the sun's shadow box around the view this frame. */
export const shadowExtent = () => curExtent;

// ------------------------------------------------------------------------------------------ HDR preparation
function findSun(img) {
  const { data, width: Wd, height: Hd } = img;
  let best = -1, bi = 0;
  for (let i = 0, n = Wd * Hd; i < n; i++) {
    const l = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    if (l > best) { best = l; bi = i; }
  }
  const row = Math.floor(bi / Wd), col = bi % Wd;
  const u = (col + 0.5) / Wd, v = 1 - (row + 0.5) / Hd;
  return { az: (u - 0.5) * Math.PI * 2, el: (v - 0.5) * Math.PI, lum: best };
}

function prepareEnv(img, shiftCols, horizonLin) {
  const { data, width: Wd, height: Hd } = img;
  const out = new Uint16Array(Wd * Hd * 4);
  const g = TUNE.groundAlbedo;
  const ground = [horizonLin.r * g[0] * 1.4, horizonLin.g * g[1] * 1.4, horizonLin.b * g[2] * 1.4];
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let row = 0; row < Hd; row++) {
    const el = (0.5 - (row + 0.5) / Hd) * Math.PI;
    // below the horizon: ground bounce; a short blend just under it
    const gk = el >= 0 ? 0 : Math.min(1, -el / (4 * Math.PI / 180));
    for (let col = 0; col < Wd; col++) {
      const src = ((col - shiftCols) % Wd + Wd) % Wd;
      const si = (row * Wd + src) * 4;
      let r = data[si], gg = data[si + 1], b = data[si + 2];
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      if (l > TUNE.sunClamp) { const k = TUNE.sunClamp / l; r *= k; gg *= k; b *= k; }
      if (gk > 0) { r += (ground[0] - r) * gk; gg += (ground[1] - gg) * gk; b += (ground[2] - b) * gk; }
      const o = (row * Wd + col) * 4;
      out[o] = toHalf(r); out[o + 1] = toHalf(gg); out[o + 2] = toHalf(b); out[o + 3] = toHalf(1);
    }
  }
  const tex = new THREE.DataTexture(out, Wd, Hd, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Average linear colour of the background image along an elevation band (degrees). */
function sampleBand(image, elDeg, bandDeg = 1.0) {
  const w = 512, h = 256;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const r0 = Math.round((0.5 - (elDeg + bandDeg) / 180) * h), r1 = Math.round((0.5 - (elDeg - bandDeg) / 180) * h);
  const d = ctx.getImageData(0, Math.max(0, r0), w, Math.max(1, r1 - r0)).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += srgbToLin(d[i] / 255); g += srgbToLin(d[i + 1] / 255); b += srgbToLin(d[i + 2] / 255); n++; }
  return new THREE.Color(r / n, g / n, b / n);
}

function skyTexture(bg, maxW) {
  let src = bg.image;
  if (src.width > maxW) {
    const cv = document.createElement('canvas');
    cv.width = maxW; cv.height = maxW / 2;
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    src = cv;
  }
  const t = new THREE.Texture(src);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------------------------------ dome
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  p.z = p.w * 0.999999;
  gl_Position = p;
}`;
const DOME_FRAG = /* glsl */`
uniform sampler2D tSky;
uniform float uRot;
uniform float uIntensity;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uHazeK;
uniform float uHaze;
varying vec3 vDir;
#include <common>
void main() {
  vec3 d = normalize( vDir );
  float el = d.y;
  vec2 uv = vec2( atan( d.z, d.x ) * RECIPROCAL_PI2 + 0.5 - uRot, asin( clamp( max( el, 0.002 ), -1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5 );
  vec3 sky = texture2D( tSky, uv ).rgb * uIntensity;
  float haze = exp( - max( el, 0.0 ) * uHazeK );
  float sunF = pow( max( dot( d, uSunDir ), 0.0 ), 5.0 );
  vec3 hz = mix( uHorizon, uHorizon * vec3( 1.12, 1.02, 0.88 ), sunF * 0.6 );
  vec3 col = mix( sky, hz, haze * uHaze );
  col = el < 0.0 ? mix( hz, hz * 0.93, smoothstep( 0.0, -0.25, el ) ) : col;
  float sd = max( dot( d, uSunDir ), 0.0 );
  col += uSunCol * ( pow( sd, 2400.0 ) * 40.0 + pow( sd, 160.0 ) * 0.6 + pow( sd, 10.0 ) * 0.06 );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------------------------------ build
/**
 * @param {THREE.Scene} scene
 * @param {object} quality  QUALITY entry
 */
export async function buildSky(scene, quality) {
  qual = quality;
  const { hdr, bg } = assets.sky(RENDER.sky);
  const found = findSun(hdr.image);
  const cfg = new THREE.Vector3(...RENDER.sunDir).normalize();
  const azTarget = Math.atan2(cfg.z, cfg.x);
  const shiftU = (azTarget - found.az) / (Math.PI * 2);
  const shiftCols = Math.round(shiftU * hdr.image.width);
  const el = found.el > 0.12 ? found.el : Math.asin(cfg.y);
  sunDir.set(Math.cos(el) * Math.cos(azTarget), Math.sin(el), Math.cos(el) * Math.sin(azTarget)).normalize();

  horizon = sampleBand(bg.image, TUNE.horizonElevDeg, 1.2).multiplyScalar(TUNE.skyIntensity);
  const scatterRef = sampleBand(bg.image, 6, 2);
  renderer.setAtmosphere({ sunDir: [sunDir.x, sunDir.y, sunDir.z], scatter: new THREE.Color(1.0, 0.88, 0.7).getHex() });

  // environment
  const envSrc = prepareEnv(hdr.image, shiftCols, scatterRef);
  const pmrem = new THREE.PMREMGenerator(gfx.renderer);
  envRT = pmrem.fromEquirectangular(envSrc);
  pmrem.dispose();
  envSrc.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = RENDER.envIntensity;
  scene.background = null;

  // sky dome
  domeMat = new THREE.ShaderMaterial({
    name: 'zf-sky',
    vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
    uniforms: {
      tSky: { value: skyTexture(bg, quality.shadowMapSize <= 1024 ? 2048 : 4096) },
      uRot: { value: shiftU }, uIntensity: { value: TUNE.skyIntensity },
      uHorizon: { value: horizon }, uSunDir: { value: sunDir }, uSunCol: { value: new THREE.Color(TUNE.sunColor) },
      uHazeK: { value: TUNE.hazeFalloff }, uHaze: { value: TUNE.hazeAmount },
    },
    depthWrite: false, depthTest: true, fog: false, toneMapped: true,
    side: THREE.BackSide,
  });
  dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), domeMat);
  dome.name = 'sky';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.matrixAutoUpdate = false;
  scene.add(dome);

  // fog in the horizon colour (the fog chunk adds the warm sun-side scatter)
  scene.fog = new THREE.FogExp2(horizon.clone(), quality.fogDensity * TUNE.fogScale);

  // sun
  sun = new THREE.DirectionalLight(TUNE.sunColor, RENDER.sunIntensity);
  sun.name = 'sun';
  sun.castShadow = true;
  target = new THREE.Object3D();
  target.name = 'sun-target';
  sun.target = target;
  scene.add(sun, target);
  applyShadowQuality(quality);
  on(EV.QUALITY_CHANGED, ({ tier }) => {
    qual = QUALITY[tier];
    applyShadowQuality(qual);
    if (scene.fog) scene.fog.density = qual.fogDensity * TUNE.fogScale;
  });
  return { sun, dome, sunDir: sunDirection() };
}

function applyShadowQuality(q) {
  range = q.shadowRange;
  if (mapSize !== q.shadowMapSize || !sun.shadow.map) {
    mapSize = q.shadowMapSize;
    sun.shadow.mapSize.set(mapSize, mapSize);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = TUNE.shadowDistance * 2;
  sun.shadow.bias = TUNE.shadowBias;
  sun.shadow.normalBias = TUNE.shadowNormalBias * Math.max(1, range / 60);
  sun.shadow.radius = TUNE.shadowRadius;
  setShadowExtent(range);
}

let curExtent = 0;
function setShadowExtent(r) {
  if (Math.abs(r - curExtent) < 0.5) return;
  curExtent = r;
  const cam = sun.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.updateProjectionMatrix();
}

// ------------------------------------------------------------------------------------------ per frame
const fwd = new THREE.Vector3(), centre = new THREE.Vector3(), lx = new THREE.Vector3(), ly = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Sky dome follows the camera; the shadow frustum follows the view (fitted, texel-snapped). */
export function updateSky(dt, viewPos, camera) {
  if (!sun) return;
  const cam = camera || gfx.camera;
  dome.position.copy(cam.position);
  dome.scale.setScalar(10);
  dome.updateMatrix();

  // altitude above ground widens the shadow box (plane, chute, menu flyover)
  const ground = heightAt(viewPos.x, viewPos.z);
  const alt = Math.max(0, viewPos.y - Math.max(ground, 0));
  const r = range * THREE.MathUtils.clamp(1 + (alt - 20) / 60, 1, 3.2);
  setShadowExtent(Math.round(r / 5) * 5);
  cam.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  centre.copy(viewPos).addScaledVector(fwd, curExtent * TUNE.shadowLead);
  centre.y = Math.max(heightAt(centre.x, centre.z), 0, Math.min(viewPos.y, ground + 30));
  // snap the centre to shadow texels in light space to stop shimmering
  lx.crossVectors(UP, sunDir).normalize();
  ly.crossVectors(sunDir, lx).normalize();
  const texel = (2 * curExtent) / mapSize;
  const px = Math.round(centre.dot(lx) / texel) * texel, py = Math.round(centre.dot(ly) / texel) * texel;
  const pz = centre.dot(sunDir);
  centre.copy(lx).multiplyScalar(px).addScaledVector(ly, py).addScaledVector(sunDir, pz);
  target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(sunDir, TUNE.shadowDistance);
  target.updateMatrixWorld();
  sun.updateMatrixWorld();
}

/** Dispose GPU resources (dev harness rebuilds). */
export function disposeSky() {
  if (envRT) envRT.dispose();
  if (domeMat) { domeMat.uniforms.tSky.value.dispose(); domeMat.dispose(); }
}
