// BLOKSTORM - your own character: keyboard and mouse input, walking, jumping and sneaking.
// Keys are looked up through "binds" (action -> key code), so every key can be changed in the settings.
import { PHYS, B } from './config.js';
import { moveBody } from './world.js';
import { clamp } from './util.js';

export const DEFAULT_BINDS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'KeyR',
  drop: 'KeyQ', inventory: 'KeyE', board: 'Tab',
};
export const BIND_LABELS = {
  forward: 'Vooruit', back: 'Achteruit', left: 'Links', right: 'Rechts', jump: 'Springen', sneak: 'Sluipen',
  sprint: 'Rennen (of 2x vooruit)', drop: 'Item weggooien', inventory: 'Inventaris', board: 'Spelerslijst',
};

export class Controller {
  constructor(canvas) {
    this.canvas = canvas;
    this.binds = { ...DEFAULT_BINDS };
    this.keys = new Set();
    this.left = false; this.right = false;
    this.pressed = [];              // one-shot actions the game reads each frame
    this.pos = { x: 0, y: 0, z: 0 }; this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; this.pitch = 0; this.ground = false; this.sneak = false; this.sprint = false; this.tapSprint = false;
    this.eyeH = PHYS.eye; this.sens = 1; this.lastTap = 0; this.bob = 0; this.speed = 0;

    addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (Object.values(this.binds).includes(e.code) || e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === this.binds.forward) { const t = performance.now(); if (t - this.lastTap < 260) this.tapSprint = true; this.lastTap = t; }
      if (e.code.startsWith('Digit')) { const n = +e.code.slice(5); if (n >= 1 && n <= 9) this.pressed.push(['slot', n - 1]); }
      if (e.code === this.binds.drop) this.pressed.push(['drop']);
      if (e.code === this.binds.inventory) this.pressed.push(['inventory']);
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); if (e.code === this.binds.forward) this.tapSprint = false; });
    addEventListener('blur', () => { this.keys.clear(); this.left = this.right = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // browsers sometimes report one huge jump, mostly right after the mouse is captured: skip those
      // A real hand speeds up gradually; a glitch is one event many times bigger than the ones around it.
      const mag = Math.hypot(e.movementX, e.movementY);
      const glitch = mag > 90 && mag > (this.mAvg || 0) * 6 + 60;
      this.mAvg = (this.mAvg || 0) * 0.8 + Math.min(mag, 200) * 0.2;
      if (performance.now() - this.lockedAt < 120 || glitch) return;
      const k = 0.0023 * this.sens;
      this.yaw -= e.movementX * k;
      this.pitch = clamp(this.pitch - e.movementY * k, -1.5, 1.5);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.left = true; this.pressed.push(['primary']); }
      if (e.button === 2) { this.right = true; this.pressed.push(['secondary']); }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.left = false;
      if (e.button === 2) { if (this.right) this.pressed.push(['release']); this.right = false; }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.locked) this.pressed.push(['scroll', e.deltaY > 0 ? 1 : -1]); }, { passive: true });
    this.lockedAt = 0;
    document.addEventListener('pointerlockchange', () => { if (this.locked) this.lockedAt = performance.now(); else { this.keys.clear(); this.left = this.right = false; } });
  }
  get locked() { return document.pointerLockElement === this.canvas; }
  lock() {
    if (this.locked) return;
    // Raw mouse input (no Windows pointer acceleration) aims steadier. Not every browser allows it: if it is
    // refused once, the normal way is used from then on.
    const plain = () => { try { const q = this.canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch { /* not allowed right now */ } };
    if (this.rawOk === false) { plain(); return; }
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { this.rawOk = false; plain(); });
    } catch { this.rawOk = false; plain(); }
  }
  unlock() { if (this.locked) document.exitPointerLock(); }
  take() { const p = this.pressed; this.pressed = []; return p; }
  /** Is the key for this action held down? */
  down(action) { return this.keys.has(this.binds[action]); }

  spawn(x, y, z, yaw) { this.pos = { x, y, z }; this.vel = { x: 0, y: 0, z: 0 }; this.yaw = yaw; this.pitch = 0; this.ground = true; this.peak = y; }

  /** mods: {speed, jump, frozen} */
  update(dt, world, mods) {
    const live = this.locked && !mods.frozen, wasGround = this.ground;
    let f = 0, s = 0;
    if (live) { f = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0); s = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0); }
    this.sneak = live && this.down('sneak');
    if (f <= 0) this.tapSprint = false;
    this.sprint = live && f > 0 && !this.sneak && mods.sprint !== false && (this.tapSprint || this.down('sprint'));
    this.jumped = false;
    const len = Math.hypot(f, s) || 1;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = (-sin * f + cos * s) / len, wz = (-cos * f - sin * s) / len;
    const speed = (this.sneak ? PHYS.sneak : this.sprint ? PHYS.sprint : PHYS.walk) * mods.speed;
    const a = Math.min(1, (this.ground ? PHYS.accelGround : PHYS.accelAir) * dt);
    this.vel.x += (wx * speed - this.vel.x) * a; this.vel.z += (wz * speed - this.vel.z) * a;
    if (live && this.down('jump') && this.ground) { this.vel.y = PHYS.jump * mods.jump; this.ground = false; this.jumped = true; }
    // slow falling: much less gravity and a low top speed downward
    this.vel.y = Math.max(mods.slowfall ? -2.6 : -PHYS.terminal, this.vel.y - PHYS.gravity * (mods.slowfall && this.vel.y < 0 ? 0.22 : 1) * dt);
    if (mods.frozen) { this.vel.x = 0; this.vel.z = 0; }
    const vy0 = this.vel.y;
    this.ground = moveBody(world, this.pos, this.vel, dt, PHYS.width, PHYS.height, this.sneak && this.ground);
    // a bounce block throws you back up and takes away the fall
    if (this.ground && vy0 < -4 && !this.sneak && world.get(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.5), Math.floor(this.pos.z)) === B.BOUNCE) {
      this.vel.y = Math.min(16, -vy0 * 0.88); this.ground = false; this.peak = this.pos.y; this.pressed.push(['bounce']);
    }
    // remember the highest point of a jump or fall; a hard landing is reported to the game
    if (!this.ground) this.peak = Math.max(this.peak ?? this.pos.y, this.pos.y);
    else { if (!wasGround && this.peak != null && this.peak - this.pos.y > 0.5) this.pressed.push(['land', this.peak - this.pos.y]); this.peak = this.pos.y; }
    this.eyeH += ((this.sneak ? PHYS.eyeSneak : PHYS.eye) - this.eyeH) * Math.min(1, dt * 14);
    const moving = this.ground ? Math.hypot(this.vel.x, this.vel.z) : 0;
    this.bob += dt * moving * 1.9;
    this.speed = moving;
  }
  eye() { return [this.pos.x, this.pos.y + this.eyeH, this.pos.z]; }
  dir() { const c = Math.cos(this.pitch); return [-Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c]; }
}
