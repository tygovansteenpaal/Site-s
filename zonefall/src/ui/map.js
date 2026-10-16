// ZONEFALL - minimap and full map. OWNER: UI. Contract: ARCHITECTURE.md 9.2.
// Base image world.getMapImage() (1024 px, north up, util.worldToMap). Minimap: heading-up square at 150 m view radius:
// self arrow with view cone, current zone (white line), next zone (dashed), gas outside shaded, a dotted line to safety
// when outside, red pings for enemy fire within TUNE.pingRange for 1.5 s, plane route during the plane phase. Full map
// (M): whole island, POI and landmark names from core/mapdata.js, a lettered grid, plane route with the jump window,
// zone circles, self marker, scale bar, legend. Rendering lives in ui/minimap.js; this file owns state and the DOM.
import { on, EV } from '../core/bus.js';
import { state, gfx, LIFE, getPlayer } from '../core/state.js';
import * as match from '../game/match.js';
import { h, setText, setTransform, show as showEl, clock } from './dom.js';
import { setBase, hasBase, drawMinimap, drawFullMap, gridRef, TUNE as MTUNE } from './minimap.js';

export const TUNE = {
  pingRange: 100,            // m: remote gunfire closer than this pings the minimap and compass
  pingLife: 1500,            // ms
  maxPings: 24,
};

let mini = null, miniCanvas = null, northEl = null, bigEl = null, bigCanvas = null, bigInfo = null, bigZone = null;
let bigOpen = false;
const pings = [];            // {x, z, t, id}
const tmpDir = { x: 0, z: -1 };

export function mount(root) {
  miniCanvas = h('canvas', { class: 'zf-minimap__canvas', 'aria-hidden': 'true' });
  northEl = h('span', { class: 'zf-minimap__north', text: 'N' });
  mini = h('div', { class: 'zf-minimap', role: 'img', 'aria-label': 'Minimap' }, miniCanvas, northEl,
    h('i', { class: 'zf-tick zf-tick--tl' }), h('i', { class: 'zf-tick zf-tick--tr' }), h('i', { class: 'zf-tick zf-tick--bl' }), h('i', { class: 'zf-tick zf-tick--br' }));

  bigCanvas = h('canvas', { class: 'zf-bigmap__canvas', 'aria-hidden': 'true' });
  bigInfo = h('span', { class: 'zf-bigmap__grid' });
  bigZone = h('span', { class: 'zf-bigmap__zone' });
  const legend = h('ul', { class: 'zf-bigmap__legend' },
    h('li', { html: '<i class="lg lg--self"></i>You' }),
    h('li', { html: '<i class="lg lg--zone"></i>Current zone' }),
    h('li', { html: '<i class="lg lg--next"></i>Next zone' }),
    h('li', { html: '<i class="lg lg--gas"></i>Gas' }),
    h('li', { html: '<i class="lg lg--plane"></i>Plane route, jump window' }),
    h('li', { html: '<i class="lg lg--ping"></i>Gunfire' }));
  bigEl = h('section', { class: 'zf-bigmap', hidden: true, 'aria-label': 'Island map' },
    h('div', { class: 'zf-bigmap__frame' },
      h('header', { class: 'zf-bigmap__head' },
        h('span', { class: 'zf-bigmap__title', text: 'Kessler Isle' }), bigInfo, bigZone),
      h('div', { class: 'zf-bigmap__view' }, bigCanvas),
      h('footer', { class: 'zf-bigmap__foot' }, legend, h('span', { class: 'zf-bigmap__close', html: 'Close <span class="zf-key" data-action="map">M</span>' }))));
  root.append(bigEl);

  on(EV.WEAPON_FIRE, onFire);
  on(EV.MATCH_START, () => { pings.length = 0; setBigOpen(false); });
  on(EV.APP_STATE, ({ to }) => { if (to !== 'match') setBigOpen(false); });
}

/** The minimap element (placed by the HUD inside its top-right cluster). */
export function element() { return mini; }

function onFire(e) {
  if (!e || e.local || e.id === state.selfId || !e.origin) return;
  const c = viewCentre();
  if (!c) return;
  const dx = e.origin[0] - c.x, dz = e.origin[2] - c.z;
  if (dx * dx + dz * dz > TUNE.pingRange * TUNE.pingRange) return;
  const now = performance.now();
  const prev = pings.find((p) => p.id === e.id && now - p.t < 400);
  if (prev) { prev.x = e.origin[0]; prev.z = e.origin[2]; prev.t = now; return; }
  pings.push({ x: e.origin[0], z: e.origin[2], t: now, id: e.id });
  if (pings.length > TUNE.maxPings) pings.shift();
}

/** Live pings (also used by the compass). */
export function activePings() {
  const now = performance.now();
  while (pings.length && now - pings[0].t > TUNE.pingLife) pings.shift();
  return pings;
}

/** Add a ping directly (dev harness). */
export function addPing(x, z, id = 'mock') { pings.push({ x, z, t: performance.now(), id }); }

/** Provide the base map image (called once after world.build). */
export function setImage(canvas) { setBase(canvas); }
export const hasImage = () => hasBase();

/** Camera heading in radians, clockwise from north (works in every camera mode). */
export function heading() {
  const cam = gfx.camera;
  if (cam && cam.matrixWorld) {
    const e = cam.matrixWorld.elements;
    tmpDir.x = -e[8]; tmpDir.z = -e[10];
    if (Math.abs(tmpDir.x) + Math.abs(tmpDir.z) > 1e-4) return Math.atan2(tmpDir.x, -tmpDir.z);
  }
  const me = getPlayer(state.selfId);
  return me ? -me.yaw : 0;
}

/** World position the maps centre on: the spectated player while spectating, else the local player. */
export function viewCentre() {
  let p = null;
  if (state.local.spectating) p = getPlayer(state.local.spectating);
  if (!p) p = getPlayer(state.selfId);
  if (p) return { x: p.pos.x, z: p.pos.z, life: p.life };
  const cam = gfx.camera;
  if (cam) return { x: cam.position.x, z: cam.position.z, life: LIFE.SPECTATE };
  return null;
}

function planeView() {
  if (state.match.phase !== 'plane') return null;
  let p;
  try { p = match.planePath(); } catch (e) { return null; }
  if (!p || !p.a) return null;
  const at = (t) => [p.a[0] + p.dir[0] * p.speed * t, p.a[1], p.a[2] + p.dir[2] * p.speed * t];
  return { a: p.a, b: p.b, doorsA: at(p.doorsOpenAt), doorsB: at(p.forceJumpAt), pos: at(Math.max(0, state.match.time)) };
}

export function updateMinimap(dt) {
  if (!mini || !mini.isConnected || mini.closest('[hidden]')) return;
  const c = viewCentre();
  if (!c) return;
  const hd = heading();
  const now = performance.now();
  const plane = planeView();
  const n = drawMinimap(miniCanvas, { x: c.x, z: c.z, heading: hd, zone: state.zone, pings: activePings(), now, plane });
  const r = mini.clientWidth / 2 - 9;
  setTransform(northEl, `translate(${(n.nx * r).toFixed(1)}px, ${(n.ny * r).toFixed(1)}px)`);
  if (bigOpen) drawBig(c, hd, now, plane);
}

function drawBig(c, hd, now, plane) {
  drawFullMap(bigCanvas, { x: c.x, z: c.z, heading: hd, zone: state.zone, pings: activePings(), now, plane, selfVisible: c.life !== LIFE.SPECTATE || !!state.local.spectating });
  setText(bigInfo, `Grid ${gridRef(c.x, c.z)}`);
  const z = state.zone;
  let zt = '';
  if (z.state === 'waiting') zt = `Next zone ${clock(z.timeLeft)}`;
  else if (z.state === 'shrinking') zt = `Zone closing ${clock(z.timeLeft)}`;
  else if (z.state === 'final') zt = 'Final zone';
  else if (state.match.phase === 'plane') zt = 'Plane route';
  setText(bigZone, zt);
}

export function setBigOpen(open) {
  open = !!open;
  if (open === bigOpen) return;
  bigOpen = open;
  showEl(bigEl, open);
  if (open) {
    const c = viewCentre();
    if (c) drawBig(c, heading(), performance.now(), planeView());
  }
}

export function isBigOpen() { return bigOpen; }

export { MTUNE as RENDER_TUNE };
