// BLOKSTORM - the blocky character: boxes mapped onto the skin canvas, a cape, hats and a flat item in the hand.
import * as THREE from 'three';
import { drawSkin, SKIN } from './textures.js';
import { LOOK } from './config.js';
import { pixelTexture, makeItem, setItem, isBlockItem } from './render.js';

const PX = 1.8 / 32;   // one skin pixel in world units; the character is 32 pixels tall

/** A box whose six faces show rectangles of the skin texture. rects: {front, back, right, left, top, bottom}. */
function part(w, h, d, rects) {
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  // three.js face order: +x, -x, +y, -y, +z, -z. The character looks toward -z.
  const order = ['right', 'left', 'top', 'bottom', 'back', 'front'];
  const light = [0.82, 0.82, 1, 0.55, 0.7, 0.92];
  const uv = geo.attributes.uv, col = new Float32Array(24 * 3);
  order.forEach((name, f) => {
    const [x, y, rw, rh] = rects[name] || rects;
    const u0 = x / SKIN.W, u1 = (x + rw) / SKIN.W, v1 = 1 - y / SKIN.H, v0 = 1 - (y + rh) / SKIN.H;
    uv.setXY(f * 4, u0, v1); uv.setXY(f * 4 + 1, u1, v1); uv.setXY(f * 4 + 2, u0, v0); uv.setXY(f * 4 + 3, u1, v0);
    for (let i = 0; i < 4; i++) col.fill(light[f], (f * 4 + i) * 3, (f * 4 + i) * 3 + 3);
  });
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
const GEO = {};
function geos() {
  if (GEO.head) return GEO;
  GEO.head = part(8, 8, 8, SKIN.head);
  GEO.body = part(8, 12, 4, SKIN.body);
  GEO.arm = part(4, 12, 4, SKIN.arm);
  GEO.leg = part(4, 12, 4, SKIN.leg);
  GEO.cape = part(10, 16, 1, SKIN.cape);
  GEO.hatA = (w, h, d) => part(w, h, d, SKIN.hatA);
  GEO.hatB = (w, h, d) => part(w, h, d, SKIN.hatB);
  return GEO;
}

export class Avatar {
  constructor(look, name = '') {
    const G = geos();
    this.group = new THREE.Group();
    this.tex = pixelTexture(drawSkin(look));
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, vertexColors: true });
    const mesh = (geo) => new THREE.Mesh(geo, this.mat);
    const pivot = (x, y, z, child, cx = 0, cy = 0, cz = 0) => {
      const g = new THREE.Group(); g.position.set(x * PX, y * PX, z * PX);
      child.position.set(cx * PX, cy * PX, cz * PX); g.add(child); this.root.add(g); return g;
    };
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.head = pivot(0, 24, 0, mesh(G.head), 0, 4, 0);
    this.body = pivot(0, 18, 0, mesh(G.body));
    this.armR = pivot(6, 22, 0, mesh(G.arm), 0, -4, 0);
    this.armL = pivot(-6, 22, 0, mesh(G.arm), 0, -4, 0);
    this.legR = pivot(2, 12, 0, mesh(G.leg), 0, -6, 0);
    this.legL = pivot(-2, 12, 0, mesh(G.leg), 0, -6, 0);
    this.cape = pivot(0, 24, 2.6, mesh(G.cape), 0, -8, 0);
    this.hat = new THREE.Group();
    this.head.add(this.hat);
    // the held item: one flat plane, so weapons are real 2D pictures
    this.item = makeItem('planks');
    this.item.visible = false;
    this.armR.add(this.item);
    this.heldId = null;
    this.walk = 0; this.swing = 0; this.capeAngle = 0.12; this.hurt = 0;
    this.setLook(look);
    if (name) this.setName(name);
  }

  setLook(look) {
    this.look = { ...look };
    this.tex.image = drawSkin(look);
    this.tex.needsUpdate = true;
    this.cape.visible = look.cape % LOOK.cape.length !== 0;
    const G = geos();
    while (this.hat.children.length) { const c = this.hat.children.pop(); c.geometry.dispose(); }
    const add = (geo, x, y, z) => { const m = new THREE.Mesh(geo, this.mat); m.position.set(x * PX, y * PX, z * PX); this.hat.add(m); };
    const hat = look.hat % LOOK.hat.length;
    if (hat === 5) { add(G.hatA(10.5, 1, 10.5), 0, 8.4, 0); add(G.hatA(7, 6, 7), 0, 11.8, 0); add(G.hatB(7.3, 1.4, 7.3), 0, 9.6, 0); }
    if (hat === 6) { for (const [x, z, w, d] of [[0, -3.5, 8, 1.2], [0, 3.5, 8, 1.2], [-3.5, 0, 1.2, 6], [3.5, 0, 1.2, 6]]) add(G.hatA(w, 1, d), x, 11.5, z); }
    if (hat === 1) { add(G.hatA(8.8, 3, 8.8), 0, 7.6, 0); add(G.hatB(8.8, 1, 4), 0, 6.4, -6); }
    if (hat === 2) { add(G.hatA(8.8, 2, 8.8), 0, 8.6, 0); for (const [x, z] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4], [0, -3.4]]) add(G.hatA(2, 2, 2), x, 10.6, z); add(G.hatB(2, 1, 1), 0, 8.6, -4.4); }
    if (hat === 3) { for (const s of [-1, 1]) { add(G.hatA(2, 2, 2), s * 4.6, 7, 0); add(G.hatA(1.4, 3, 1.4), s * 5.4, 9.4, 0); } }
    if (hat === 4) { add(G.hatA(8.8, 2, 8.8), 0, 5.6, 0); add(G.hatB(2, 2, 1), 0, 5.6, -4.4); }
  }

  setName(name) {
    if (this.tag) { this.group.remove(this.tag); this.tag.material.map.dispose(); }
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = '16px Silkscreen, monospace';
    const w = Math.ceil(g.measureText(name).width) + 12;
    c.width = w; c.height = 22;
    g.font = '16px Silkscreen, monospace';
    g.fillStyle = 'rgba(11,12,12,.72)'; g.fillRect(0, 0, w, 22);
    g.fillStyle = '#e9e7e1'; g.textBaseline = 'middle'; g.fillText(name, 6, 12);
    const mat = new THREE.SpriteMaterial({ map: pixelTexture(c), depthWrite: false });
    this.tag = new THREE.Sprite(mat);
    this.tag.scale.set(w / 22 * 0.3, 0.3, 1);
    this.tag.position.y = 2.25;
    this.group.add(this.tag);
  }

  hold(id) {
    if (id === this.heldId) return;
    this.heldId = id;
    this.item.visible = !!id;
    if (!id) return;
    setItem(this.item, id);
    if (isBlockItem(id)) { this.item.scale.setScalar(0.5); this.item.position.set(0, -11 * PX, -3 * PX); this.item.rotation.set(0.3, 0.6, 0); }
    else { this.item.scale.setScalar(0.72); this.item.position.set(0, -9.5 * PX, -6 * PX); this.item.rotation.set(0, Math.PI / 2, -0.5); }
  }
  attack() { this.swing = 1; }
  flash() { this.hurt = 0.45; }

  /** s: {speed, ground, sneak, pitch} */
  update(dt, s) {
    const moving = Math.min(1, s.speed / 4.4);
    this.walk += dt * (4 + s.speed * 1.9) * (moving > 0.05 ? 1 : 0);
    const sw = Math.sin(this.walk) * 0.9 * moving;
    this.legR.rotation.x = sw; this.legL.rotation.x = -sw;
    this.armL.rotation.x = sw;
    this.swing = Math.max(0, this.swing - dt * 4.5);
    const hit = Math.sin(this.swing * Math.PI) * 1.6;
    this.armR.rotation.x = (this.heldId ? 0.35 : 0) - sw + hit;
    this.armR.rotation.z = -hit * 0.25;
    if (s.block) { this.armR.rotation.x = 1.25; this.armR.rotation.z = -0.55; }
    this.head.rotation.x = s.pitch || 0;
    const lean = s.sneak ? 0.42 : 0;
    this.body.rotation.x = -lean; this.head.position.z = -lean * 3 * PX; this.armR.position.z = this.armL.position.z = -lean * 3 * PX;
    this.root.position.y = s.sneak ? -2 * PX : 0;
    const target = 0.1 + moving * 0.75 + (s.ground ? 0 : 0.35) + Math.sin(performance.now() / 300) * 0.04;
    this.capeAngle += (target - this.capeAngle) * Math.min(1, dt * 6);
    this.cape.rotation.x = -this.capeAngle;
    this.cape.position.z = (2.6 - lean * 4) * PX;
    if (this.hurt > 0) { this.hurt -= dt; this.mat.color.setRGB(1, 0.45, 0.45); } else this.mat.color.setRGB(1, 1, 1);
  }

  dispose() {
    this.tex.dispose(); this.mat.dispose();
    if (this.tag) this.tag.material.map.dispose();
  }
}
