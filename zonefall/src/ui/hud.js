// ZONEFALL - in-match HUD. OWNER: UI. Contract: ARCHITECTURE.md 9.2.
// Compass strip (top centre, heading from the camera, POI bearings, zone pin, gunfire pings), zone timer under it,
// minimap (top right, via ui/map.js) with players-alive and kills counters, kill feed (right, 5 lines, 5 s), health bar +
// three armor plate segments + carried plates (bottom left), weapon name / fire mode / mag / reserve / frags and the
// second slot dimmed (bottom right), dynamic crosshair from state.local.spread (hidden at full ADS), hitmarkers
// (HIT_CONFIRMED: white, red on kill, distinct headshot and armor-break), damage direction arcs (PLAYER_DAMAGED dir),
// low-health vignette, gas tint while outside the zone, interaction prompt from state.local.nearby, action progress ring
// (state.local.action/actionT), plane/freefall/chute prompts and altimeter, sniper scope overlay when
// state.local.scoped, scoreboard on Tab, FPS when settings.showFps.
// Online: a connection banner under the zone timer while every other player has gone silent (NET_LINK 'interrupted'),
// and the aimed-at nameplate: the player or bot under the crosshair, within range and in line of sight
// (world.lineOfSight, ARCHITECTURE.md 5.7), gets its name and distance above the head.
import * as THREE from 'three';
import { on, EV } from '../core/bus.js';
import { state, gfx, LIFE, FLAG, getPlayer, hasFlag } from '../core/state.js';
import * as settings from '../core/settings.js';
import { WEAPONS, AMMO, ZONE, MATCH, DEV, PLAYER } from '../config.js';
import { POIS, LANDMARKS } from '../core/mapdata.js';
import * as input from '../engine/input.js';
import * as renderer from '../engine/renderer.js';
import * as session from '../net/session.js';
import * as match from '../game/match.js';
import * as map from './map.js';
import * as world from '../world/world.js';
import { h, setText, setClass, setVar, setTransform, show as vis, keycap, keyOf, GLYPH, clock } from './dom.js';

export const TUNE = {
  compassSpan: 150,          // degrees visible across the compass strip
  killFeedLines: 5,
  killFeedMs: 5000,
  hitmarkerMs: 280,
  arcMs: 1600,
  arcSlots: 4,
  chipDelay: 0.45,           // s before the red damage chip on the health bar drains
  pickupLines: 4,
  pickupMs: 3200,
  announceMs: 3000,
  lowHealth: 35,
  plateRange: 90,            // m: aimed-at nameplate range (x1.8 while aiming down sights)
  plateMinDeg: 1.2,          // smallest aim cone for the nameplate, deg (widened to the body's angular size up close)
  plateLosMs: 120,           // line-of-sight re-check interval for the nameplate target
  plateHoldMs: 450,          // the nameplate stays this long after the crosshair leaves the target
};

const MODE = { auto: 'Auto', semi: 'Semi', bolt: 'Bolt' };
const DEG = 180 / Math.PI;

let el = null, visible = false;
const $ = {};
let compassW = 0, pxPerDeg = 1, compassMarks = [];
let lastWeaponKey = '', magPips = [];
let hpShown = 100, hpChip = 100, chipHold = 0, lastHp = 100;
let feed = [], pickups = [], arcs = [], announceQ = [], announceUntil = 0;
let hitTimer = 0, killBannerTimer = 0;
let fpsTimer = 0, sbTimer = 0;
let lastZoneOutside = false;

// ------------------------------------------------------------------------------------------ build
function tpl() {
  return `
  <div class="zf-hud__top">
    <div class="zf-compass" aria-hidden="true">
      <div class="zf-compass__window"><div class="zf-compass__strip"></div><div class="zf-compass__marks"></div></div>
      <div class="zf-compass__caret"></div>
      <div class="zf-compass__hdg"><span data-hdg>000</span></div>
    </div>
    <div class="zf-zonetimer" data-state="pre">
      <span class="zf-zonetimer__phase" data-zphase></span>
      <span class="zf-zonetimer__label" data-zlabel></span>
      <span class="zf-zonetimer__time" data-ztime>0:00</span>
      <span class="zf-zonetimer__bar"><i data-zbar></i></span>
    </div>
    <div class="zf-netwarn" hidden role="status">
      <span class="zf-netwarn__dot" aria-hidden="true"></span>
      <span class="zf-netwarn__text">Connection interrupted</span>
      <span class="zf-netwarn__sub">Waiting for the other players</span>
    </div>
    <div class="zf-zonewarn" hidden>
      <span class="zf-zonewarn__icon">${GLYPH.gas}</span>
      <span class="zf-zonewarn__text">Outside the zone</span>
      <span class="zf-zonewarn__dps" data-zdps></span>
      <span class="zf-zonewarn__dir" data-zdir>${GLYPH.arrow}</span>
      <span class="zf-zonewarn__dist" data-zdist></span>
    </div>
  </div>
  <div class="zf-announce" hidden><span class="zf-announce__kicker" data-ak></span><span class="zf-announce__title" data-at></span><span class="zf-announce__sub" data-as></span></div>
  <div class="zf-hud__tr">
    <div class="zf-hud__mapslot"></div>
    <div class="zf-counters">
      <span class="zf-counter" title="Players alive">${GLYPH.alive}<b data-alive>16</b><i>Alive</i></span>
      <span class="zf-counter" title="Your kills">${GLYPH.kills}<b data-kills>0</b><i>Kills</i></span>
    </div>
    <ol class="zf-feed" aria-live="polite"></ol>
  </div>
  <div class="zf-hud__bl">
    <div class="zf-vitals">
      <div class="zf-vitals__head">
        <span class="zf-vitals__name" data-name></span>
        <span class="zf-vitals__plates" title="Armor plates carried">${GLYPH.plate}<b data-plates>0</b><span class="zf-key" data-action="plate">4</span></span>
      </div>
      <div class="zf-armor"><i><b></b></i><i><b></b></i><i><b></b></i></div>
      <div class="zf-health">
        <div class="zf-health__track"><i class="zf-health__chip"></i><i class="zf-health__fill"></i><span class="zf-health__ticks"></span></div>
        <span class="zf-health__num" data-hp>100</span>
      </div>
      <div class="zf-vitals__note" data-vnote></div>
    </div>
  </div>
  <div class="zf-hud__br">
    <ol class="zf-pickups"></ol>
    <div class="zf-weapon">
      <div class="zf-weapon__slots"><span class="zf-slot" data-slot="0"></span><span class="zf-slot" data-slot="1"></span></div>
      <div class="zf-weapon__main">
        <div class="zf-weapon__id"><span class="zf-weapon__name" data-wname>1911</span><span class="zf-weapon__mode" data-wmode>Semi</span></div>
        <div class="zf-weapon__ammo"><span class="zf-weapon__mag" data-mag>8</span><span class="zf-weapon__res"><i>/</i><b data-res>24</b><small data-cal>.45</small></span></div>
        <div class="zf-weapon__pips"></div>
      </div>
      <div class="zf-weapon__aux"><span class="zf-frag" title="Frag grenades">${GLYPH.frag}<b data-frags>0</b><span class="zf-key" data-action="grenade">G</span></span></div>
    </div>
  </div>
  <div class="zf-nameplate" hidden aria-hidden="true"><b data-npn></b><span data-npd></span></div>
  <div class="zf-center">
    <div class="zf-cross"><i class="t"></i><i class="r"></i><i class="b"></i><i class="l"></i><i class="d"></i></div>
    <svg class="zf-hit" viewBox="-30 -30 60 60" aria-hidden="true"><g><path d="M-17 -17L-7 -7M17 -17L7 -7M-17 17L-7 7M17 17L7 7"/></g><circle class="zf-hit__ring" r="14"/></svg>
    <div class="zf-arcs"></div>
    <svg class="zf-ring" viewBox="0 0 80 80" aria-hidden="true"><circle class="zf-ring__bg" cx="40" cy="40" r="30"/><circle class="zf-ring__fg" cx="40" cy="40" r="30" pathLength="100"/></svg>
    <div class="zf-ringlabel" data-ringlabel></div>
    <div class="zf-killbanner" hidden><span data-kbk>Eliminated</span><b data-kbn></b><i data-kbh></i></div>
    <div class="zf-prompt" hidden><span class="zf-prompt__key"></span><span class="zf-prompt__verb" data-pverb></span><span class="zf-prompt__item" data-pitem></span><span class="zf-prompt__sub" data-psub></span></div>
    <div class="zf-callout" hidden><span class="zf-callout__key"></span><span class="zf-callout__txt"><span data-ctext></span><small data-csub></small></span></div>
    <div class="zf-alt" hidden>
      <div class="zf-alt__tape"><div class="zf-alt__ticks"></div></div>
      <div class="zf-alt__read"><b data-alt>0</b><i>m</i></div>
      <div class="zf-alt__vs"><span data-vs>0</span> m/s</div>
    </div>
  </div>
  <div class="zf-scope" hidden>
    <div class="zf-scope__mask"></div>
    <svg class="zf-scope__reticle" viewBox="-500 -500 1000 1000" aria-hidden="true">
      <g class="zf-scope__posts"><rect x="-500" y="-3.5" width="360" height="7"/><rect x="140" y="-3.5" width="360" height="7"/><rect x="-3.5" y="140" width="7" height="360"/></g>
      <g class="zf-scope__fine"><line x1="-140" y1="0" x2="140" y2="0"/><line x1="0" y1="-500" x2="0" y2="140"/></g>
      <g class="zf-scope__dots"></g>
    </svg>
    <div class="zf-scope__info"><span>4.0x</span><span>Mil-dot</span></div>
    <div class="zf-scope__breath"><span class="zf-key" data-action="sprint">Shift</span><span>Hold breath</span><i><b data-breath></b></i></div>
  </div>
  <div class="zf-fps" hidden data-fps></div>
  <section class="zf-scoreboard" hidden aria-label="Players">
    <header><span class="zf-label">Operators</span><b data-sbalive></b><span class="zf-scoreboard__mode" data-sbmode></span></header>
    <table><thead><tr><th>#</th><th>Operator</th><th>Kills</th><th>Damage</th><th>Ping</th><th>Status</th></tr></thead><tbody></tbody></table>
  </section>`;
}

function buildCompass() {
  const strip = $.compassStrip;
  const W = $.compass.clientWidth || 520;
  if (W === compassW && strip.childElementCount) return;
  compassW = W;
  pxPerDeg = W / TUNE.compassSpan;
  strip.textContent = '';
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const fr = document.createDocumentFragment();
  for (let d = -180; d <= 540; d += 5) {
    const n = ((d % 360) + 360) % 360;
    const major = n % 15 === 0;
    const tick = document.createElement('i');
    tick.className = 'zf-compass__tick' + (major ? ' is-major' : '') + (names[n] && n % 90 === 0 ? ' is-card' : '');
    tick.style.left = (d * pxPerDeg).toFixed(1) + 'px';
    fr.append(tick);
    if (major) {
      const lab = document.createElement('span');
      lab.className = 'zf-compass__lab' + (names[n] ? (n % 90 === 0 ? ' is-card' : ' is-inter') : '');
      lab.textContent = names[n] || String(n);
      lab.style.left = (d * pxPerDeg).toFixed(1) + 'px';
      fr.append(lab);
    }
  }
  strip.append(fr);
}

function buildMarks() {
  const wrap = $.compassMarks;
  wrap.textContent = '';
  compassMarks = [];
  const zm = h('span', { class: 'zf-cmark zf-cmark--zone' }, h('i'), h('b', { text: 'Zone' }), h('em'));
  compassMarks.push({ kind: 'zone', el: zm, dist: zm.querySelector('em') });
  for (const s of [...POIS, ...LANDMARKS]) {
    const m = h('span', { class: 'zf-cmark' + (POIS.includes(s) ? ' is-major' : '') }, h('i'), h('b', { text: s.name }), h('em'));
    wrap.append(m);
    compassMarks.push({ kind: 'site', site: s, el: m, dist: m.querySelector('em') });
  }
  wrap.append(zm);
  for (let i = 0; i < 8; i++) {
    const pm = h('span', { class: 'zf-cmark zf-cmark--ping' }, h('i'));
    wrap.append(pm);
    compassMarks.push({ kind: 'ping', idx: i, el: pm });
  }
}

function buildScopeDots() {
  const g = $.scope.querySelector('.zf-scope__dots');
  let s = '';
  for (let i = 1; i <= 4; i++) {
    const v = i * 30;
    s += `<circle cx="${v}" cy="0" r="3.4"/><circle cx="${-v}" cy="0" r="3.4"/><circle cx="0" cy="${v}" r="3.4"/>`;
    if (i < 4) s += `<line x1="0" y1="${-v - 15}" x2="0" y2="${-v - 15}"/>`;
  }
  // bullet drop hash marks under the centre for 200 / 300 / 400 m
  s += '<line class="drop" x1="-18" y1="22" x2="18" y2="22"/><line class="drop" x1="-14" y1="46" x2="14" y2="46"/><line class="drop" x1="-10" y1="74" x2="10" y2="74"/>';
  g.innerHTML = s;
}

export function mount(root) {
  el = h('section', { class: 'zf-hud', hidden: true, 'aria-label': 'Heads-up display' });
  el.innerHTML = tpl();
  root.append(el);
  const q = (s) => el.querySelector(s);
  Object.assign($, {
    compass: q('.zf-compass'), compassStrip: q('.zf-compass__strip'), compassMarks: q('.zf-compass__marks'), hdg: q('[data-hdg]'),
    zt: q('.zf-zonetimer'), ztPhase: q('[data-zphase]'), ztLabel: q('[data-zlabel]'), ztTime: q('[data-ztime]'), ztBar: q('[data-zbar]'),
    nw: q('.zf-netwarn'),
    np: q('.zf-nameplate'), npName: q('[data-npn]'), npDist: q('[data-npd]'),
    zw: q('.zf-zonewarn'), zwDps: q('[data-zdps]'), zwDir: q('[data-zdir]'), zwDist: q('[data-zdist]'),
    ann: q('.zf-announce'), annK: q('[data-ak]'), annT: q('[data-at]'), annS: q('[data-as]'),
    mapSlot: q('.zf-hud__mapslot'), alive: q('[data-alive]'), kills: q('[data-kills]'), feed: q('.zf-feed'),
    bl: q('.zf-hud__bl'), name: q('[data-name]'), plates: q('[data-plates]'), platesWrap: q('.zf-vitals__plates'),
    armor: [...el.querySelectorAll('.zf-armor > i')], armorWrap: q('.zf-armor'),
    health: q('.zf-health'), hpFill: q('.zf-health__fill'), hpChip: q('.zf-health__chip'), hpNum: q('[data-hp]'), vnote: q('[data-vnote]'),
    br: q('.zf-hud__br'), pickups: q('.zf-pickups'), weapon: q('.zf-weapon'), slots: [...el.querySelectorAll('.zf-slot')],
    wname: q('[data-wname]'), wmode: q('[data-wmode]'), mag: q('[data-mag]'), res: q('[data-res]'), cal: q('[data-cal]'), pips: q('.zf-weapon__pips'),
    frags: q('[data-frags]'), fragWrap: q('.zf-frag'),
    center: q('.zf-center'), cross: q('.zf-cross'), hit: q('.zf-hit'), arcs: q('.zf-arcs'),
    ring: q('.zf-ring'), ringFg: q('.zf-ring__fg'), ringLabel: q('[data-ringlabel]'),
    kb: q('.zf-killbanner'), kbK: q('[data-kbk]'), kbN: q('[data-kbn]'), kbH: q('[data-kbh]'),
    prompt: q('.zf-prompt'), pKey: q('.zf-prompt__key'), pVerb: q('[data-pverb]'), pItem: q('[data-pitem]'), pSub: q('[data-psub]'),
    callout: q('.zf-callout'), cKey: q('.zf-callout__key'), cText: q('[data-ctext]'), cSub: q('[data-csub]'),
    alt: q('.zf-alt'), altTicks: q('.zf-alt__ticks'), altNum: q('[data-alt]'), vs: q('[data-vs]'),
    scope: q('.zf-scope'), breath: q('[data-breath]'), scBreath: q('.zf-scope__breath'),
    fps: q('[data-fps]'), sb: q('.zf-scoreboard'), sbBody: q('.zf-scoreboard tbody'), sbAlive: q('[data-sbalive]'), sbMode: q('[data-sbmode]'),
  });
  // health ticks every 10 hp
  const ticks = el.querySelector('.zf-health__ticks');
  for (let i = 1; i < 10; i++) ticks.append(h('i', { style: { left: `${i * 10}%` } }));
  // altimeter tape ticks: every 10 m over 0..400 m
  for (let a = 0; a <= 400; a += 10) $.altTicks.append(h('i', { class: a % 50 === 0 ? 'is-major' : '', style: { bottom: `${a * 2}px` }, data: { a: a % 50 === 0 ? String(a) : '' } }));
  for (let i = 0; i < TUNE.arcSlots; i++) {
    const a = h('div', { class: 'zf-arc', html: '<svg viewBox="-100 -100 200 200" aria-hidden="true"><path d="M-46 -84 A96 96 0 0 1 46 -84" /></svg>' });
    $.arcs.append(a);
    arcs.push({ el: a, until: 0, bearing: 0, from: null });
  }
  $.mapSlot.append(map.element());
  buildMarks();
  buildScopeDots();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { compassW = 0; buildCompass(); }).observe($.compass);

  on(EV.HIT_CONFIRMED, onHit);
  on(EV.PLAYER_KILLED, onKilled);
  on(EV.PLAYER_DAMAGED, onDamaged);
  on(EV.LOOT_PICKED, ({ by, item }) => { if (by === state.selfId && item) addPickup(pickupText(item)); });
  on(EV.CRATE_OPENED, ({ by }) => { if (by === state.selfId) addPickup('Supply crate opened'); });
  on(EV.MATCH_START, onMatchStart);
  on(EV.PLANE_DOORS, ({ open }) => { if (open && localLife() === LIFE.PLANE) announce('Green light', 'Doors open', [`Press `, keycap('jump'), ' to jump']); });
  on(EV.ZONE_PHASE, ({ phase, state: zs, seconds }) => {
    // an eliminated player reading his recap (not spectating) does not need zone news across the Eliminated screen
    const me = getPlayer(state.selfId);
    if (me && !me.alive && !state.local.spectating) return;
    if (zs === 'waiting') announce(`Zone ${phase + 1} of ${ZONE.phases.length}`, 'Zone marked', `Closes in ${clock(seconds)}. Check the map.`);
    else if (zs === 'shrinking') announce(`Zone ${phase + 1} of ${ZONE.phases.length}`, 'Zone closing', 'Get inside the white circle');
  });
  on(EV.WEAPON_SWITCH, ({ id }) => { if (id === state.selfId) { $.weapon.classList.remove('is-swap'); void $.weapon.offsetWidth; $.weapon.classList.add('is-swap'); } });
  on(EV.PLATE_DONE, ({ id }) => { if (id === state.selfId) { $.armorWrap.classList.remove('is-done'); void $.armorWrap.offsetWidth; $.armorWrap.classList.add('is-done'); } });
  on(EV.SETTINGS_CHANGED, ({ key }) => { if (key === 'showFps') vis($.fps, !!settings.get('showFps')); });
  on(EV.NET_LINK, ({ state: st }) => setLink(st));
  on('input:bindings', () => refreshKeys());
}

function refreshKeys() {
  for (const k of el.querySelectorAll('.zf-key[data-action]')) if (k.dataset.action) k.textContent = keyOf(k.dataset.action);
}

// ------------------------------------------------------------------------------------------ events
function nameOf(id) {
  if (!id) return '';
  const p = getPlayer(id);
  if (p) return p.name;
  const r = (state.match.roster || []).find((x) => x.id === id);
  return r ? r.name : 'Unknown';
}

function weaponLabel(w) {
  if (!w) return '';
  if (WEAPONS[w]) return WEAPONS[w].name;
  return String(w).toUpperCase();
}

/** Clear transient HUD state (kill feed, pickups, banners, arcs). */
export function reset() {
  feed = []; pickups = []; announceQ = []; announceUntil = 0;
  $.feed.textContent = ''; $.pickups.textContent = '';
  vis($.ann, false); vis($.kb, false);
  for (const a of arcs) a.until = 0;
  hpShown = hpChip = lastHp = PLAYER.health;
  killBannerTimer = 0; hitTimer = 0;
}

function onMatchStart() {
  reset();
  setLink('ok');
  plate.id = null; plate.until = 0; vis($.np, false);
  announce('Kessler Isle', `${state.match.roster.length || MATCH.maxPlayers} operators`, 'Last one standing wins');
}

function onHit({ zone, kill, armorBroke }) {
  const svg = $.hit;
  svg.classList.remove('is-head', 'is-kill', 'is-armor', 'is-on');
  if (kill) svg.classList.add('is-kill');
  else if (zone === 'head') svg.classList.add('is-head');
  if (armorBroke) svg.classList.add('is-armor');
  void svg.getBoundingClientRect();
  svg.classList.add('is-on');
  hitTimer = TUNE.hitmarkerMs / 1000;
}

function onKilled({ id, by, weapon, headshot }) {
  const self = state.selfId;
  const li = h('li', { class: 'zf-feed__row' + (by === self || id === self ? ' is-self' : '') });
  if (by && by !== id && weapon !== 'left') {
    li.append(...[h('span', { class: 'zf-feed__name' + (by === self ? ' is-me' : ''), text: nameOf(by) }),
      h('span', { class: 'zf-feed__weapon', text: weaponLabel(weapon) }),
      headshot ? h('span', { class: 'zf-feed__hs', html: GLYPH.head, title: 'Headshot' }) : null,
      h('span', { class: 'zf-feed__name zf-feed__name--victim' + (id === self ? ' is-me' : ''), text: nameOf(id) })].filter(Boolean));
  } else {
    const how = weapon === 'zone' ? 'lost to the zone' : weapon === 'fall' ? 'fell to their death' : weapon === 'left' ? 'left the match' : weapon === 'frag' ? 'was killed by their own frag' : 'was eliminated';
    li.append(h('span', { class: 'zf-feed__name zf-feed__name--victim' + (id === self ? ' is-me' : ''), text: nameOf(id) }),
      h('span', { class: 'zf-feed__how', text: how }));
  }
  $.feed.prepend(li);
  feed.unshift({ el: li, t: performance.now() });
  while (feed.length > TUNE.killFeedLines) feed.pop().el.remove();

  if (by === self && id !== self) {
    onHit({ zone: headshot ? 'head' : 'body', kill: true, armorBroke: false });
    setText($.kbK, headshot ? 'Headshot' : 'Eliminated');
    setText($.kbN, nameOf(id));
    const p = getPlayer(id);
    const me = getPlayer(self);
    $.kbH.textContent = p && me ? `${weaponLabel(weapon)}  ${Math.round(p.pos.distanceTo(me.pos))} m` : weaponLabel(weapon);
    vis($.kb, true);
    $.kb.classList.remove('is-on'); void $.kb.offsetWidth; $.kb.classList.add('is-on');
    killBannerTimer = 2.4;
  }
}

function onDamaged({ id, amount, dir, from, armorBroke, kind }) {
  if (id !== state.selfId) return;
  el.classList.remove('is-hurt'); void el.offsetWidth; el.classList.add('is-hurt');
  if (armorBroke) note('Armor broken', 'warn');
  if (kind === 'zone' || !dir) return;
  // attacker bearing (clockwise from north) = direction from victim back along the shot
  const bearing = Math.atan2(-dir[0], dir[2]);
  let slot = arcs.find((a) => a.from && a.from === from) || arcs.reduce((m, a) => (a.until < m.until ? a : m), arcs[0]);
  slot.from = from || null;
  slot.bearing = bearing;
  slot.until = performance.now() + TUNE.arcMs;
  slot.strength = Math.min(1, 0.45 + (amount || 20) / 60);
}

let noteTimer = 0;
function note(text, kind) {
  setText($.vnote, text);
  $.vnote.dataset.kind = kind || '';
  setClass($.vnote, 'is-on', true);
  noteTimer = 2.2;
}

function pickupText(item) {
  switch (item.type) {
    case 'weapon': return `${weaponLabel(item.ref)} picked up`;
    case 'ammo': return `+${item.qty} ${AMMO[item.ref] ? AMMO[item.ref].name : item.ref} ammo`;
    case 'plate': return item.qty > 1 ? `+${item.qty} armor plates` : '+1 armor plate';
    case 'frag': return '+1 frag grenade';
    default: return String(item.type);
  }
}

function addPickup(text) {
  const li = h('li', { class: 'zf-pickups__row', text });
  $.pickups.append(li);
  pickups.push({ el: li, t: performance.now() });
  while (pickups.length > TUNE.pickupLines) pickups.shift().el.remove();
}

/** Queue a banner: kicker (small), title (large letter-spaced), sub (string or array of nodes). */
export function announce(kicker, title, sub) {
  announceQ.push({ kicker, title, sub });
  if (announceQ.length > 3) announceQ.shift();
}

// ------------------------------------------------------------------------------------------ API
export function show() {
  if (!el) return;
  visible = true;
  el.hidden = false;
  compassW = 0;
  buildCompass();
  vis($.fps, !!settings.get('showFps'));
}

export function hide() {
  if (!el) return;
  visible = false;
  el.hidden = true;
  map.setBigOpen(false);
}

function localLife() {
  const me = getPlayer(state.selfId);
  return me ? me.life : LIFE.SPECTATE;
}

const wrap180 = (d) => ((d + 540) % 360) - 180;

function updateCompass(hdgRad, cx, cz) {
  if (!compassW) buildCompass();
  const hdg = ((hdgRad * DEG) % 360 + 360) % 360;
  setTransform($.compassStrip, `translate3d(${(compassW / 2 - hdg * pxPerDeg).toFixed(1)}px,0,0)`);
  setText($.hdg, String(Math.round(hdg) % 360).padStart(3, '0'));
  const half = TUNE.compassSpan / 2 - 3;
  const pings = map.activePings();
  const now = performance.now();
  const z = state.zone;
  let zoneRel = 999;
  for (const m of compassMarks) {
    let tx, tz, label = null, visibleMark = true;
    if (m.kind === 'site') {
      tx = m.site.x; tz = m.site.z;
      const d = Math.hypot(tx - cx, tz - cz);
      if (d < m.site.r * 0.6) visibleMark = false;
      else label = `${Math.round(d / 10) * 10} m`;
    } else if (m.kind === 'zone') {
      if (!(z.r > 0) || z.state === 'pre') visibleMark = false;
      else {
        const dCur = Math.hypot(cx - z.x, cz - z.z);
        if (dCur > z.r) { tx = z.x; tz = z.z; label = `${Math.round(dCur - z.r)} m`; }
        else if (z.nr > 0 && z.state !== 'final' && Math.hypot(cx - z.nx, cz - z.nz) > z.nr) { tx = z.nx; tz = z.nz; label = `${Math.round(Math.hypot(cx - z.nx, cz - z.nz) - z.nr)} m`; }
        else visibleMark = false;
      }
    } else {
      const p = pings[pings.length - 1 - m.idx];
      if (!p || now - p.t > map.TUNE.pingLife) visibleMark = false;
      else { tx = p.x; tz = p.z; setVar(m.el, '--a', 1 - (now - p.t) / map.TUNE.pingLife); }
    }
    if (visibleMark) {
      const bearing = Math.atan2(tx - cx, -(tz - cz)) * DEG;
      const rel = wrap180(bearing - hdg);
      if (Math.abs(rel) > half) visibleMark = false;
      else {
        setTransform(m.el, `translate3d(${(compassW / 2 + rel * pxPerDeg).toFixed(1)}px,0,0)`);
        if (m.kind === 'zone') zoneRel = rel;
        if (m.kind === 'site') setClass(m.el, 'is-focus', Math.abs(rel) < 9 && Math.abs(rel - zoneRel) > 16);
        if (label != null && m.dist) setText(m.dist, label);
      }
    }
    vis(m.el, visibleMark);
  }
}

function zoneDuration(z) {
  const mult = DEV.fastZone ? 0.1 : 1;
  const ph = ZONE.phases[Math.max(0, z.phase)];
  if (!ph) return 1;
  if (z.state === 'waiting') return ph.wait * mult;
  if (z.state === 'shrinking') return ph.shrink * mult;
  if (z.state === 'pre') return ZONE.startAt * mult;
  return 1;
}

function updateZone(hdgRad, cx, cz, alive) {
  const z = state.zone;
  const live = state.match.phase === 'live' || state.match.phase === 'ended';
  vis($.zt, live && z.state !== 'idle');
  if (live) {
    $.zt.dataset.state = z.state;
    const labels = { pre: 'Zone forms', waiting: 'Next zone', shrinking: 'Zone closing', final: 'Final zone' };
    setText($.ztLabel, labels[z.state] || '');
    setText($.ztPhase, z.phase >= 0 ? `${z.phase + 1}/${ZONE.phases.length}` : '');
    setText($.ztTime, z.state === 'final' ? '' : clock(z.timeLeft));
    const frac = z.state === 'final' ? 1 : 1 - Math.max(0, Math.min(1, z.timeLeft / zoneDuration(z)));
    setTransform($.ztBar, `scaleX(${frac.toFixed(3)})`);
  }
  const outside = !!(z.outside && alive && live);
  vis($.zw, outside);
  if (outside !== lastZoneOutside) { lastZoneOutside = outside; setClass(el, 'is-gas', outside); }
  if (outside) {
    setText($.zwDps, `-${z.dps} HP/s`);
    const bearing = Math.atan2(z.x - cx, -(z.z - cz));
    const rel = bearing - hdgRad;
    setTransform($.zwDir, `rotate(${(rel * DEG).toFixed(1)}deg)`);
    setText($.zwDist, `${Math.max(0, Math.round(Math.hypot(cx - z.x, cz - z.z) - z.r))} m`);
  }
}

function updateVitals(me, inv, dt) {
  const hp = Math.max(0, me.hp);
  if (hp < lastHp - 0.01) chipHold = TUNE.chipDelay;
  lastHp = hp;
  hpShown = hp;
  if (chipHold > 0) chipHold -= dt;
  else hpChip += (hp - hpChip) * (1 - Math.exp(-9 * dt));
  if (hpChip < hp) hpChip = hp;
  setTransform($.hpFill, `scaleX(${(hpShown / 100).toFixed(4)})`);
  setTransform($.hpChip, `scaleX(${(hpChip / 100).toFixed(4)})`);
  setText($.hpNum, Math.ceil(hp));
  setClass($.health, 'is-low', hp < TUNE.lowHealth);
  setClass($.health, 'is-regen', hp < 100 && performance.now() - state.local.lastDamageAt > PLAYER.regenDelay * 1000);
  setText($.name, state.name || me.name);
  const armor = Math.max(0, me.armor);
  const per = PLAYER.armor.perPlate;
  const plating = state.local.action === 'plate';
  let next = -1;
  for (let i = 0; i < 3; i++) {
    const f = Math.max(0, Math.min(1, (armor - per * i) / per));
    setVar($.armor[i], '--f', f);
    setClass($.armor[i], 'is-full', f >= 0.999);
    if (next < 0 && f < 0.999) next = i;
  }
  for (let i = 0; i < 3; i++) {
    const ins = plating && i === next;
    setClass($.armor[i], 'is-insert', ins);
    if (ins) setVar($.armor[i], '--p', state.local.actionT);
  }
  const plates = inv ? inv.plates : 0;
  setText($.plates, plates);
  setClass($.platesWrap, 'is-empty', plates === 0);
  if (noteTimer > 0) { noteTimer -= dt; if (noteTimer <= 0) setClass($.vnote, 'is-on', false); }
}

function buildPips(n) {
  $.pips.textContent = '';
  magPips = [];
  for (let i = 0; i < n; i++) { const p = document.createElement('i'); $.pips.append(p); magPips.push(p); }
  $.pips.dataset.n = String(n);
}

function updateWeapon(inv) {
  const L = state.local;
  const slot = inv && inv.slots ? inv.slots[inv.active] : null;
  const W = slot ? WEAPONS[slot.weapon] : null;
  for (let i = 0; i < 2; i++) {
    const s = inv && inv.slots ? inv.slots[i] : null;
    const sEl = $.slots[i];
    const txt = s ? WEAPONS[s.weapon].name : 'Empty';
    const key = `${i}:${txt}:${inv && inv.active === i}`;
    if (sEl.__k !== key) {
      sEl.__k = key;
      sEl.textContent = '';
      sEl.append(h('span', { class: 'zf-key', data: { action: i ? 'slot2' : 'slot1' }, text: keyOf(i ? 'slot2' : 'slot1') }), h('span', { text: txt }));
    }
    setClass(sEl, 'is-active', !!inv && inv.active === i);
    setClass(sEl, 'is-empty', !s);
  }
  setClass($.weapon, 'is-unarmed', !W);
  if (!W) {
    setText($.wname, 'Unarmed'); setText($.wmode, ''); setText($.mag, '-'); setText($.res, '0'); setText($.cal, '');
    if (lastWeaponKey !== 'none') { lastWeaponKey = 'none'; buildPips(0); }
  } else {
    const wkey = slot.weapon;
    if (wkey !== lastWeaponKey) { lastWeaponKey = wkey; buildPips(W.mag); }
    setText($.wname, W.name);
    setText($.wmode, MODE[W.mode] || W.mode);
    const reserve = inv.ammo ? inv.ammo[W.ammo] || 0 : 0;
    setText($.mag, slot.mag);
    setText($.res, reserve);
    setText($.cal, AMMO[W.ammo] ? AMMO[W.ammo].name : '');
    const low = slot.mag <= Math.ceil(W.mag * 0.25);
    setClass($.weapon, 'is-low', low && slot.mag > 0);
    setClass($.weapon, 'is-empty', slot.mag === 0);
    setClass($.weapon, 'is-reloading', L.action === 'reload');
    for (let i = 0; i < magPips.length; i++) setClass(magPips[i], 'is-spent', i >= slot.mag);
  }
  const frags = inv ? inv.frags : 0;
  setText($.frags, frags);
  setClass($.fragWrap, 'is-empty', frags === 0);
}

function updateCrosshair(me, alive, life) {
  const L = state.local;
  const slot = L.inv && L.inv.slots ? L.inv.slots[L.inv.active] : null;
  const sprint = hasFlag(me, FLAG.SPRINT);
  const busy = L.action === 'plate' || L.action === 'throw';
  const on = alive && life === LIFE.GROUND && !!slot && !L.scoped && !busy;
  const op = on ? Math.max(0, 1 - L.ads * 2.2) * (sprint ? 0.25 : 1) : 0;
  setVar($.cross, '--o', op);
  if (op > 0) {
    const cam = gfx.camera;
    const vfov = (cam && cam.fov ? cam.fov : 70) * Math.PI / 180;
    const half = window.innerHeight / 2;
    const gap = 5 + Math.tan((Math.max(0, L.spread) * Math.PI / 180) / 2) / Math.tan(vfov / 2) * half;
    setVar($.cross, '--gap', Math.min(90, gap).toFixed(1) + 'px');
  }
}

function updateCenter(me, alive, life, inv, dt) {
  const L = state.local;
  // action ring
  let ring = null;
  if (alive && L.action === 'reload') ring = ['Reloading', L.actionT];
  else if (alive && L.action === 'plate') ring = ['Armor plate', L.actionT];
  else if (alive && L.action === 'throw' && L.cook > 0) ring = [`Cooking ${(Math.max(0, WEAPONS.frag.fuse - L.cook)).toFixed(1)}`, L.actionT];
  vis($.ring, !!ring);
  vis($.ringLabel, !!ring);
  if (ring) {
    setVar($.ringFg, '--p', ring[1]);
    setText($.ringLabel, ring[0]);
    setClass($.ring, 'is-cook', L.action === 'throw');
  }

  // interaction prompt
  const nb = alive && life === LIFE.GROUND ? L.nearby : null;
  vis($.prompt, !!nb);
  if (nb) {
    const key = keyOf('interact');
    if ($.pKey.__k !== key) { $.pKey.__k = key; $.pKey.textContent = ''; $.pKey.append(h('span', { class: 'zf-key', data: { action: 'interact' }, text: key })); }
    setText($.pVerb, nb.type === 'crate' ? 'Open' : 'Pick up');
    setText($.pItem, nb.label || '');
    let sub = '';
    if (nb.type === 'weapon' && WEAPONS[nb.ref]) sub = `${nb.qty} rds  ${MODE[WEAPONS[nb.ref].mode] || ''}  ${AMMO[WEAPONS[nb.ref].ammo] ? AMMO[WEAPONS[nb.ref].ammo].name : ''}`;
    else if (nb.type === 'crate') sub = 'Three items';
    setText($.pSub, sub);
    $.prompt.dataset.rarity = nb.rarity || 'common';
  }

  // contextual callouts: plane, freefall, chute, reload
  let call = null;
  if (life === LIFE.PLANE) {
    let auto = '';
    try { const p = match.planePath(); auto = `Automatic jump in ${clock(Math.max(0, p.forceJumpAt - state.match.time))}`; } catch (e) { auto = ''; }
    call = L.canDeploy ? ['jump', 'Jump', auto] : [null, 'Doors open over the island', 'Stand by'];
  } else if (life === LIFE.FREEFALL) {
    call = L.canDeploy ? ['jump', 'Open parachute', `Opens automatically at ${PLAYER.freefall.autoDeployAGL} m`] : [null, 'Too low to deploy', ''];
  } else if (life === LIFE.CHUTE) {
    call = L.canDeploy ? ['jump', 'Cut parachute', ''] : null;
  } else if (alive && life === LIFE.GROUND && inv && inv.slots && inv.slots[inv.active] && !L.action) {
    const s = inv.slots[inv.active];
    const W = WEAPONS[s.weapon];
    if (s.mag === 0) call = (inv.ammo && inv.ammo[W.ammo] > 0) ? ['reload', 'Reload', ''] : [null, 'No ammo', `Find ${AMMO[W.ammo].name} rounds`];
  }
  vis($.callout, !!call && !nb);
  if (call && !nb) {
    const k = call[0] ? keyOf(call[0]) : '';
    if ($.cKey.__k !== k) { $.cKey.__k = k; $.cKey.textContent = ''; if (k) $.cKey.append(h('span', { class: 'zf-key', data: { action: call[0] }, text: k })); }
    vis($.cKey, !!k);
    setText($.cText, call[1]);
    setText($.cSub, call[2]);
    $.callout.dataset.kind = life === LIFE.GROUND ? 'ground' : 'air';
  }

  // altimeter
  const air = life === LIFE.PLANE || life === LIFE.FREEFALL || life === LIFE.CHUTE;
  vis($.alt, air);
  if (air) {
    const a = Math.max(0, L.altitude);
    setText($.altNum, Math.round(a));
    setText($.vs, (me.vel ? me.vel.y : 0).toFixed(0));
    setTransform($.altTicks, `translate3d(0, ${(a * 2).toFixed(1)}px, 0)`);
    setClass($.alt, 'is-low', life === LIFE.FREEFALL && a < PLAYER.freefall.autoDeployAGL + 30);
  }

  // hitmarker lifetime
  if (hitTimer > 0) { hitTimer -= dt; if (hitTimer <= 0) $.hit.classList.remove('is-on'); }
  if (killBannerTimer > 0) { killBannerTimer -= dt; if (killBannerTimer <= 0) vis($.kb, false); }
}

function updateArcs(hdgRad, cx, cz) {
  const now = performance.now();
  for (const a of arcs) {
    const left = a.until - now;
    if (left <= 0) { if (a.el.__on) { a.el.__on = false; setVar(a.el, '--o', 0); } continue; }
    a.el.__on = true;
    let bearing = a.bearing;
    const src = a.from ? getPlayer(a.from) : null;
    if (src && src.alive) bearing = Math.atan2(src.pos.x - cx, -(src.pos.z - cz));
    setTransform(a.el, `rotate(${((bearing - hdgRad) * DEG).toFixed(1)}deg)`);
    setVar(a.el, '--o', Math.min(1, left / 500) * (a.strength || 1));
  }
}

function updateScope(dt) {
  const L = state.local;
  const on = !!L.scoped;
  vis($.scope, on);
  if (!on) return;
  setTransform($.breath, `scaleX(${Math.max(0, Math.min(1, L.breath)).toFixed(3)})`);
  setClass($.scBreath, 'is-holding', safeDown('sprint'));
  setClass($.scBreath, 'is-tired', L.breath < 0.05);
}

function safeDown(a) { try { return !!input.down(a); } catch (e) { return false; } }

function updateFeed() {
  const now = performance.now();
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i];
    const age = now - f.t;
    if (age > TUNE.killFeedMs) { f.el.remove(); feed.splice(i, 1); }
    else if (age > TUNE.killFeedMs - 600) setClass(f.el, 'is-out', true);
  }
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    const age = now - p.t;
    if (age > TUNE.pickupMs) { p.el.remove(); pickups.splice(i, 1); }
    else if (age > TUNE.pickupMs - 500) setClass(p.el, 'is-out', true);
  }
  if (announceUntil && now > announceUntil) { announceUntil = 0; vis($.ann, false); }
  if (!announceUntil && announceQ.length) {
    const a = announceQ.shift();
    setText($.annK, a.kicker || '');
    setText($.annT, a.title || '');
    $.annS.textContent = '';
    if (Array.isArray(a.sub)) a.sub.forEach((n) => $.annS.append(n instanceof Node ? n : document.createTextNode(String(n))));
    else $.annS.textContent = a.sub || '';
    vis($.ann, true);
    $.ann.classList.remove('is-on'); void $.ann.offsetWidth; $.ann.classList.add('is-on');
    announceUntil = now + TUNE.announceMs;
  }
}

function updateScoreboard() {
  const open = state.app === 'match' && safeDown('scoreboard');
  vis($.sb, open);
  setClass(el, 'is-board', open);
  if (!open) { sbTimer = 0; return; }
  if (sbTimer-- > 0) return;
  sbTimer = 15;
  const rtt = new Map();
  if (state.online) { try { for (const p of session.diagnostics().peers || []) rtt.set(p.id, p.rtt); } catch (e) { /* offline */ } }
  const rows = (state.match.roster.length ? state.match.roster : [...state.players.values()].map((p) => ({ id: p.id, name: p.name, kind: p.kind }))).map((r) => {
    const p = getPlayer(r.id);
    return { id: r.id, name: p ? p.name : r.name, bot: r.kind === 'bot' || (p && p.kind === 'bot'), alive: !!(p && p.alive && p.life !== LIFE.SPECTATE), kills: p ? p.kills : 0, damage: p ? Math.round(p.damage) : 0, gone: !p };
  });
  rows.sort((a, b) => (b.alive - a.alive) || (b.kills - a.kills) || (b.damage - a.damage));
  $.sbBody.textContent = '';
  rows.forEach((r, i) => {
    const self = r.id === state.selfId;
    const ping = self ? '' : r.bot ? 'BOT' : rtt.has(r.id) ? `${rtt.get(r.id)} ms` : state.online ? '...' : '';
    $.sbBody.append(h('tr', { class: (self ? 'is-self ' : '') + (r.alive ? '' : 'is-dead') },
      h('td', { text: String(i + 1).padStart(2, '0') }),
      h('td', { text: r.name }),
      h('td', { text: String(r.kills) }),
      h('td', { text: String(r.damage) }),
      h('td', { text: ping }),
      h('td', { text: r.gone ? 'Left' : r.alive ? 'Alive' : 'Out' })));
  });
  setText($.sbAlive, `${rows.filter((r) => r.alive).length} alive`);
  setText($.sbMode, state.match.mode === 'practice' ? 'Practice' : state.match.mode === 'private' ? 'Private match' : 'Quick play');
}

export function update(dt) {
  if (!visible || !el) return;
  const me = getPlayer(state.selfId);
  const life = me ? me.life : LIFE.SPECTATE;
  const alive = !!(me && me.alive && life !== LIFE.DEAD && life !== LIFE.SPECTATE);
  const spectating = !!state.local.spectating;
  const inv = state.local.inv;
  const c = map.viewCentre() || { x: 0, z: 0 };
  const hdg = map.heading();

  el.dataset.life = String(life);
  setClass(el, 'is-dead', !alive);
  setClass(el, 'is-spectating', spectating);
  setClass(el, 'is-air', life === LIFE.PLANE || life === LIFE.FREEFALL || life === LIFE.CHUTE);
  setClass(el, 'is-scoped', !!state.local.scoped);

  updateCompass(hdg, c.x, c.z);
  updateZone(hdg, c.x, c.z, alive);
  setText($.alive, state.match.alive || 0);
  setText($.kills, me ? me.kills : state.match.stats.kills);
  if (me && alive) { updateVitals(me, inv, dt); updateWeapon(inv); }
  if (me) updateCrosshair(me, alive, life);
  updateCenter(me || { vel: null }, alive, life, inv, dt);
  updateArcs(hdg, c.x, c.z);
  if (me) updateNameplate(me, alive && !spectating); else vis($.np, false);
  updateScope(dt);
  updateFeed();
  map.updateMinimap(dt);
  const low = alive ? Math.max(0, Math.min(1, (TUNE.lowHealth + 10 - me.hp) / (TUNE.lowHealth + 10))) : 0;
  setVar(el, '--low', low);
  updateScoreboard();
  if (!$.fps.hidden && (fpsTimer -= dt) <= 0) {
    fpsTimer = 0.5;
    try { const s = renderer.stats(); setText($.fps, `${s.fps} FPS  ${s.ms} MS  ${s.calls} CALLS  ${String(s.tier).toUpperCase()}`); } catch (e) { setText($.fps, ''); }
  }
}

/** HUD root (dev harness). */
export function element() { return el; }

// ------------------------------------------------------------------------------------------ connection banner
/** NET_LINK state -> banner: 'interrupted' shows it; 'ok' hides it, and so does 'lost' (the death screen explains it). */
export function setLink(st) {
  if (!$.nw) return;
  vis($.nw, st === 'interrupted');
}

// ------------------------------------------------------------------------------------------ nameplate
const plate = { id: null, until: 0, losAt: 0, losId: null, los: false };
const npEye = new THREE.Vector3(), npAt = new THREE.Vector3(), npProj = new THREE.Vector3();

/** The player or bot under the crosshair (alive, in range, in the aim cone), or null. */
function aimedAt(me) {
  const eye = state.local.eye, dir = state.local.aimDir;
  if (!eye || !dir) return null;
  const range = TUNE.plateRange * (state.local.ads > 0.5 ? 1.8 : 1);
  let best = null, bestScore = Infinity;
  for (const e of state.players.values()) {
    if (e === me || !e.alive || e.life === LIFE.DEAD || e.life === LIFE.SPECTATE || e.life === LIFE.PLANE) continue;
    const dx = e.pos.x - eye.x, dy = e.pos.y + 1.15 - eye.y, dz = e.pos.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1 || d > range) continue;
    const along = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (along <= 0) continue;
    const ang = Math.acos(Math.min(1, along)) * DEG;
    const cone = Math.max(TUNE.plateMinDeg, Math.atan2(0.75, d) * DEG);   // about a body width either side
    if (ang > cone) continue;
    const score = ang / cone + d / range * 0.25;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function updateNameplate(me, alive) {
  const now = performance.now();
  let target = null;
  if (alive && !state.local.scoped) {
    const cand = aimedAt(me);
    if (cand) {
      if (cand.id !== plate.losId || now - plate.losAt > TUNE.plateLosMs) {
        plate.losId = cand.id;
        plate.losAt = now;
        npEye.copy(state.local.eye);
        npAt.set(cand.pos.x, cand.pos.y + 1.4, cand.pos.z);
        try { plate.los = world.lineOfSight(npEye, npAt); } catch (e) { plate.los = true; }
      }
      if (plate.los) target = cand;
    }
  }
  if (target) { plate.id = target.id; plate.until = now + TUNE.plateHoldMs; }
  const e = plate.id && now < plate.until ? getPlayer(plate.id) : null;
  if (!e || !e.alive || !alive || !gfx.camera) { vis($.np, false); return; }
  npProj.set(e.pos.x, e.pos.y + 2.05 + (hasFlag(e, FLAG.CROUCH) ? -0.45 : 0), e.pos.z).project(gfx.camera);
  if (npProj.z > 1 || Math.abs(npProj.x) > 1.05 || Math.abs(npProj.y) > 1.05) { vis($.np, false); return; }
  const w = el.clientWidth || innerWidth, hgt = el.clientHeight || innerHeight;
  setTransform($.np, `translate(${((npProj.x + 1) / 2 * w).toFixed(1)}px, ${((1 - npProj.y) / 2 * hgt).toFixed(1)}px) translate(-50%, -100%)`);
  setText($.npName, e.name);
  setText($.npDist, `${Math.round(e.pos.distanceTo(me.pos))} m`);
  setClass($.np, 'is-human', e.kind === 'remote');
  vis($.np, true);
}
