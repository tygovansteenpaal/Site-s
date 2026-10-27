// ZONEFALL - mod menu (aimbot, ESP, fly). OWNER: GAME.
// N shows the menu; J aimbot, K ESP, L fly, U infinite ammo, I RPG without cooldown, O gives an RPG. Only active in practice and private matches, never in Quick play, so
// strangers are never on the receiving end. The aimbot turns the view to the enemy nearest the crosshair while the aim
// button is held (in line of sight, within TUNE.fovDeg). ESP draws a box, name, distance and health over every player.
// Fly is player/controller's free flight.
import * as THREE from 'three';
import { state, gfx, localPlayer, LIFE, APP } from '../core/state.js';
import * as input from '../engine/input.js';
import * as world from '../world/world.js';
import * as camera from '../player/camera.js';
import * as controller from '../player/controller.js';
import * as weapons from '../combat/weapons.js';

const TUNE = { fovDeg: 30, maxDist: 400, headY: 1.62, chestY: 1.25, smooth: 22 };
const KEYS = { menu: 'KeyN', aim: 'KeyJ', esp: 'KeyK', fly: 'KeyL', ammo: 'KeyU', rpg: 'KeyI', give: 'KeyO' };
const on = { aim: false, esp: false, fly: false, ammo: false, rpg: false, head: true };

let panel = null, canvas = null, ctx = null, shown = false;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _t = new THREE.Vector3();

/** Mods work only where nobody joined expecting a fair game. */
export function allowed() {
  return state.app === APP.MATCH && (state.match.mode === 'practice' || state.match.mode === 'private');
}

const targetable = (e, me) => e && e !== me && e.alive && e.life !== LIFE.PLANE && e.life !== LIFE.SPECTATE && e.life !== LIFE.DEAD;

function visible(from, to) {
  _d.subVectors(to, from);
  const len = _d.length();
  if (len < 1e-3) return true;
  _d.multiplyScalar(1 / len);
  const h = world.raycast(from, _d, len - 0.4);
  return !h;
}

// ------------------------------------------------------------------------------------------ menu
function build() {
  panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:90px;left:16px;z-index:60;min-width:210px;padding:12px 14px;background:rgba(12,14,12,.86);'
    + 'border:1px solid rgba(255,255,255,.18);color:#e8e6df;font:13px/1.5 ui-monospace,Menlo,monospace;pointer-events:none;display:none';
  document.body.appendChild(panel);
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:55;pointer-events:none';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  addEventListener('keydown', (e) => {
    if (e.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName)) return;
    if (e.code === KEYS.menu) shown = !shown;
    else if (e.code === KEYS.aim) on.aim = !on.aim;
    else if (e.code === KEYS.esp) on.esp = !on.esp;
    else if (e.code === KEYS.fly) on.fly = !on.fly;
    else if (e.code === KEYS.ammo) on.ammo = !on.ammo;
    else if (e.code === KEYS.rpg) on.rpg = !on.rpg;
    else if (e.code === KEYS.give) giveRpg();
    else return;
    render();
  }, { capture: true });
  render();
}

function render() {
  if (!panel) return;
  const row = (key, label, v) => `<div><span style="opacity:.6">${key}</span>  ${label} <b style="color:${v ? '#9be37a' : '#e0806b'}">${v ? 'AAN' : 'UIT'}</b></div>`;
  panel.innerHTML = '<div style="letter-spacing:.12em;opacity:.7;margin-bottom:6px">MOD MENU</div>'
    + row('J', 'Aimbot (rechtermuis)', on.aim) + row('K', 'ESP', on.esp) + row('L', 'Vliegen', on.fly)
    + row('U', 'Oneindig ammo', on.ammo) + row('I', 'RPG zonder cooldown', on.rpg)
    + '<div><span style="opacity:.6">O</span>  RPG pakken</div>'
    + '<div style="opacity:.55;margin-top:6px">Spatie omhoog, C omlaag, Shift snel</div>'
    + (allowed() ? '' : '<div style="color:#e0b26b;margin-top:6px">Alleen in oefenen en private match</div>')
    + '<div style="opacity:.55">N sluit dit menu</div>';
  panel.style.display = shown ? 'block' : 'none';
}

function giveRpg() {
  const me = localPlayer();
  if (!allowed() || !me || !me.alive || me.life !== LIFE.GROUND) return;
  const inv = state.local.inv;
  const slot = inv && inv.slots ? (inv.slots.findIndex((x) => x && x.weapon === 'rpg') >= 0 ? inv.slots.findIndex((x) => x && x.weapon === 'rpg')
    : inv.slots[0] ? (inv.slots[1] ? (inv.active ?? 0) : 1) : 0) : 0;
  weapons.giveFull('rpg', slot);
}

// ------------------------------------------------------------------------------------------ aimbot
/** After camera.look: turn the view onto the best target while aiming. */
export function aim(dt) {
  const me = localPlayer();
  if (!on.aim || !allowed() || !me || !me.alive || !input.down('ads')) return;
  camera.getAimRay(_o, _d);
  let best = null, bestAng = TUNE.fovDeg * Math.PI / 180;
  for (const e of state.players.values()) {
    if (!targetable(e, me)) continue;
    _p.set(e.pos.x, e.pos.y + (on.head ? TUNE.headY : TUNE.chestY), e.pos.z);
    _q.subVectors(_p, _o);
    const dist = _q.length();
    if (dist > TUNE.maxDist || dist < 0.5) continue;
    const ang = _q.angleTo(_d);
    if (ang > bestAng || !visible(_o, _p)) continue;
    bestAng = ang; best = _t.copy(_p);
  }
  if (!best) return;
  const k = 1 - Math.exp(-TUNE.smooth * dt);
  const dx = best.x - _o.x, dy = best.y - _o.y, dz = best.z - _o.z;
  const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  me.yaw += Math.atan2(Math.sin(yaw - me.yaw), Math.cos(yaw - me.yaw)) * k;
  me.pitch += (pitch - me.pitch) * k;
}

// ------------------------------------------------------------------------------------------ ESP
function drawEsp() {
  const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const me = localPlayer();
  if (!on.esp || !allowed() || !me) return;
  const cam = gfx.camera;
  ctx.font = '11px ui-monospace,Menlo,monospace';
  ctx.textAlign = 'center';
  for (const e of state.players.values()) {
    if (!targetable(e, me)) continue;
    _p.set(e.pos.x, e.pos.y + 1.85, e.pos.z).project(cam);
    _q.set(e.pos.x, e.pos.y, e.pos.z).project(cam);
    if (_p.z > 1 || _q.z > 1 || _p.z < -1) continue;                 // behind the camera
    const x = (_q.x + 1) / 2 * w, yb = (1 - _q.y) / 2 * h, yt = (1 - _p.y) / 2 * h;
    const bh = Math.max(6, yb - yt), bw = bh * 0.45;
    const dist = Math.round(cam.position.distanceTo(e.pos));
    _t.set(e.pos.x, e.pos.y + TUNE.chestY, e.pos.z);
    const seen = visible(cam.position, _t);
    const bot = e.kind === 'bot';
    ctx.strokeStyle = seen ? '#ff5a4a' : (bot ? 'rgba(255,190,90,.8)' : 'rgba(120,200,255,.85)');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - bw / 2, yt, bw, bh);
    const hp = Math.max(0, Math.min(1, (e.hp || 0) / 100));
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - bw / 2 - 5, yt, 3, bh);
    ctx.fillStyle = hp > 0.5 ? '#7ee06a' : hp > 0.25 ? '#e8c45a' : '#e8604f';
    ctx.fillRect(x - bw / 2 - 5, yt + bh * (1 - hp), 3, bh * hp);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${e.name}${bot ? ' (bot)' : ''}  ${dist} m`, x, yt - 4);
  }
}

// ------------------------------------------------------------------------------------------ public API
export function init() { if (!panel) build(); }

/** After camera.update: fly state follows the toggle, ESP redraws. */
export function update() {
  if (!panel) return;
  const fly = on.fly && allowed();
  if (fly !== controller.flying()) controller.setFly(fly);
  weapons.setMods({ infiniteAmmo: on.ammo && allowed(), rapidRpg: on.rpg && allowed() });
  drawEsp();
  if (shown) {
    const want = allowed() ? '' : 'x';
    if (panel.dataset.a !== want) { panel.dataset.a = want; render(); }
  }
}
