// ZONEFALL - UI facade: screen switching and per-frame HUD refresh. OWNER: UI. Contract: ARCHITECTURE.md 5.7 and 9.
// Plain DOM inside #ui (no framework). Screens follow state.app (APP_STATE): loading, menu, lobby, match
// (hud + overlays), results. Every interactive element plays audio.ui('hover'/'click') through one delegated listener
// and sends intents with emit(EV.UI_INTENT, {type, ...}) (types in ARCHITECTURE.md 9.3); the UI never calls net/game
// modules directly, except read-only getters (lobby.get(), world.getMapImage(), renderer.stats(), session.diagnostics(),
// match.planePath()) and viewmodel.setScopeOverlay(false): the UI draws the scope (ARCHITECTURE.md 6.4).
import { on, emit, EV } from '../core/bus.js';
import { state, debug, APP, LIFE, getPlayer } from '../core/state.js';
import { MATCH } from '../config.js';
import * as input from '../engine/input.js';
import * as world from '../world/world.js';
import * as viewmodel from '../combat/viewmodel.js';
import * as lobbyNet from '../net/lobby.js';
import * as menu from './menu.js';
import * as lobby from './lobby.js';
import * as hud from './hud.js';
import * as map from './map.js';
import * as screens from './screens.js';
import { h, sfx, sfxClick, unlockAudio, refreshKeycaps, GLYPH, codeName } from './dom.js';

export const TUNE = {
  deathScreenDelay: 2500,    // ms after the local death (the death cam runs first)
  toastMax: 4,
};

let root = null, toastsEl = null, fatalEl = null;
let deathAt = 0, deathShown = false, lastSpecId = undefined, lockedThisMatch = false;
const uiPressed = new Set();   // key codes pressed this frame while the pointer is free (overlays)
let lastHover = null;
let inited = false;

// ------------------------------------------------------------------------------------------ init
/** Mount all screens into root and show the loading screen. Must not depend on the renderer (runs first at boot). */
export function init(r) {
  if (inited) return;
  if (!r) throw new Error('[UI/ui] init needs the #ui root element');
  inited = true;
  root = r;
  root.classList.add('zf-ui');
  root.textContent = '';

  menu.mount(root);
  lobby.mount(root);
  map.mount(root);       // the big map lives at root level; the minimap element is placed by the HUD
  hud.mount(root);
  screens.mount(root);
  toastsEl = h('div', { class: 'zf-toasts', 'aria-live': 'polite' });
  root.append(toastsEl);

  wireSounds();
  wireEvents();
  addEventListener('keydown', (e) => {
    if (e.repeat || isText(e.target)) return;
    uiPressed.add(e.code);
  });
  exposeDebug();
  menu.showLoading(0, 'Starting');
}

function isText(t) { return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }

function wireSounds() {
  const interactive = 'button, a, [role="tab"], [role="switch"], input[type="range"]';
  root.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest(interactive);
    if (!t || t === lastHover || t.disabled) return;
    lastHover = t;
    sfx('hover');
  });
  root.addEventListener('pointerout', (e) => {
    const t = e.target.closest && e.target.closest(interactive);
    if (t && t === lastHover && !t.contains(e.relatedTarget)) lastHover = null;
  });
  root.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches(':focus-visible') && t.matches(interactive)) sfx('hover');
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('button, a, [role="tab"]');
    if (t && !t.disabled) sfxClick();
  });
  // first gesture anywhere unlocks audio (browser autoplay policy)
  const unlock = () => unlockAudio();
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });
}

function wireEvents() {
  on(EV.APP_STATE, ({ from, to }) => applyApp(to, from));
  on(EV.LOAD_PROGRESS, ({ p, label }) => setLoading(p, label));
  on(EV.TOAST, ({ text, kind, ms }) => toast(text, kind, ms));
  on(EV.LOBBY_UPDATE, ({ lobby: l }) => lobby.render(l));
  let netErrorToastAt = -1e9;
  on(EV.NET_STATUS, ({ status, text }) => {
    // the lobby screen keeps showing the error and retries by itself: one toast per minute, not one per attempt
    if (status !== 'error' || state.app !== APP.LOBBY || performance.now() - netErrorToastAt < 60000) return;
    netErrorToastAt = performance.now();
    toast(text || 'Connection problem', 'danger', 5000);
  });
  on(EV.MATCH_START, () => {
    deathAt = 0; deathShown = false; lastSpecId = undefined; lockedThisMatch = false;
    screens.hideAll();
    hideScopeFromViewmodel();
  });
  on(EV.PLAYER_KILLED, ({ id }) => {
    if (id !== state.selfId || state.app !== APP.MATCH) return;
    deathAt = performance.now() + TUNE.deathScreenDelay;
    deathShown = false;
  });
  on(EV.NET_LINK, ({ state: st }) => {
    // Lost the match connection while already dead or spectating: the explanation replaces whatever was showing.
    if (st !== 'lost' || state.app !== APP.MATCH) return;
    const wasAlive = !!getPlayer(state.selfId)?.alive;
    queueMicrotask(() => {                // after game/match has recorded the forfeit (state.match.netLost)
      if (wasAlive || state.app !== APP.MATCH) return;   // a living player dies from the forfeit; PLAYER_KILLED shows it
      deathAt = 0; deathShown = true;
      screens.showSpectate(null);
      screens.showDeath({ killer: state.local.killer });
    });
  });
  const announceEnd = (winnerId) => {
    const name = winnerId ? (getPlayer(winnerId)?.name || '') : '';
    if (winnerId && winnerId === state.selfId) hud.announce('Match over', 'Victory', getPlayer(state.selfId)?.alive ? 'Last one standing' : 'Last one to fall');
    else hud.announce('Match over', name ? `${name} wins` : 'Match over', `Results in ${MATCH.endDelay} seconds`);
  };
  on(EV.MATCH_END, ({ winnerId }) => { if (state.app === APP.MATCH) announceEnd(winnerId); });
  // a death that reached us after the end re-ranked the match (game/match): show the corrected result
  on(EV.MATCH_RESULT, ({ winnerId }) => {
    if (state.app === APP.RESULTS) screens.showResults(resultsInfo());
    else if (state.app === APP.MATCH) announceEnd(winnerId);
  });
  on('input:bindings', () => refreshKeycaps(root));
}

function hideScopeFromViewmodel() {
  try { if (typeof viewmodel.setScopeOverlay === 'function') viewmodel.setScopeOverlay(false); } catch (e) { /* viewmodel not ready */ }
}

function ensureMapImage() {
  if (map.hasImage()) return;
  try { map.setImage(world.getMapImage()); } catch (e) { /* world not built yet (harness or early boot) */ }
}

function applyApp(to) {
  if (to !== APP.LOADING) menu.hideLoading();
  if (to === APP.MENU || to === APP.LOBBY || to === APP.MATCH) ensureMapImage();
  if (to === APP.MENU) { menu.show(); lobby.hide(); hud.hide(); screens.hideAll(); }
  else if (to === APP.LOBBY) {
    menu.hide(); hud.hide(); screens.hideAll(); lobby.show();
    try { lobby.render(lobbyNet.get()); } catch (e) { /* lobby not initialised yet */ }
  } else if (to === APP.MATCH) {
    menu.hide(); lobby.hide(); hud.show();
    hideScopeFromViewmodel();
  } else if (to === APP.RESULTS) {
    hud.hide();
    screens.showResults(resultsInfo());
  } else if (to === APP.LOADING) {
    menu.hide(); lobby.hide(); hud.hide(); screens.hideAll();
    menu.showLoading();
  }
}

function resultsInfo() {
  return {
    winnerId: state.match.winnerId,
    placement: state.match.placement,
    total: state.match.roster.length || MATCH.maxPlayers,
    mode: state.match.mode,
    stats: { ...state.match.stats },
  };
}

// ------------------------------------------------------------------------------------------ per frame
function codesOf(action) {
  try { return input.bindings()[action] || []; } catch (e) { return []; }
}

/** An action edge from the game input (pointer locked) or from a raw key while the pointer is free. */
function pressedAction(action) {
  let p = false;
  try { p = input.pressed(action); } catch (e) { p = false; }
  if (p) return true;
  for (const c of codesOf(action)) if (uiPressed.has(c)) return true;
  return false;
}

function lockedNow() { try { return input.isLocked(); } catch (e) { return false; } }

/** Per frame: HUD values from state (health, armor, ammo, compass, zone timer, minimap, prompts). */
export function update(dt) {
  if (!inited) return;
  const app = state.app;
  if (app === APP.LOBBY) lobby.tick();
  if (app === APP.MATCH) updateMatch(dt);
  if (app === APP.RESULTS) screens.updateResultsNext(state.online ? lobbyNet.nextRound() : null);
  uiPressed.clear();
}

function updateMatch(dt) {
  const me = getPlayer(state.selfId);
  const dead = !!me && (!me.alive || me.life === LIFE.DEAD || me.life === LIFE.SPECTATE);
  const locked = lockedNow();
  const now = performance.now();

  const lost = !!state.match.netLost;   // disconnected from the match: the explanation stays, no spectating
  if (deathAt && !deathShown && now >= deathAt && dead && (!state.local.spectating || lost)) {
    deathShown = true;
    if (lost) screens.showSpectate(null);
    screens.showDeath({ killer: state.local.killer });
  }
  // spectate bar follows the camera's target
  const spec = lost ? null : (state.local.spectating || null);
  if (spec !== lastSpecId) {
    lastSpecId = spec;
    if (spec && dead) screens.showSpectate(getPlayer(spec)?.name || '');
    else screens.showSpectate(null);
  }
  if (spec && dead) screens.updateSpectate(spec);

  const practice = state.match.mode === 'practice';
  // the overlay shows whenever the pointer is free, and also when practice is paused while the lock is still held
  // (the simulation would otherwise sit frozen with no way back except Escape)
  // A dead player uses the death screen and the spectate bar instead (both have Leave match); practice does not pause
  // once the local player is dead (main.js).
  const pauseOpen = (!locked || (practice && state.paused)) && !dead && state.match.phase !== 'ended';
  if (locked) lockedThisMatch = true;
  screens.showPause(pauseOpen, { fresh: !lockedThisMatch && !dead });

  if (!pauseOpen) {
    if (dead && screens.isOpen('death') && pressedAction('jump')) { sfx('confirm'); emit(EV.UI_INTENT, { type: 'spectate' }); }
    else if (dead && spec) {
      if (pressedAction('left')) emit(EV.UI_INTENT, { type: 'spectate_prev' });
      else if (pressedAction('right') || pressedAction('fire')) emit(EV.UI_INTENT, { type: 'spectate_next' });
    }
    if (pressedAction('map')) { map.setBigOpen(!map.isBigOpen()); sfx(map.isBigOpen() ? 'click' : 'back'); }
  } else if (map.isBigOpen()) map.setBigOpen(false);

  hud.update(dt);
}

// ------------------------------------------------------------------------------------------ loading, toasts, fatal
/** Loading screen progress (p 0..1, label). */
export function setLoading(p, label) {
  if (!inited) return;
  menu.showLoading(p, label);
}

/** Transient message (TOAST events also land here). kind: 'info' | 'warn' | 'danger'. */
export function toast(text, kind = 'info', ms = 2600) {
  if (!inited || !text) return;
  const k = ['info', 'warn', 'danger'].includes(kind) ? kind : 'info';
  const el = h('div', { class: `zf-toast zf-toast--${k}`, role: k === 'danger' ? 'alert' : 'status' },
    h('span', { class: 'zf-toast__bar' }), h('span', { class: 'zf-toast__text', text: String(text) }));
  toastsEl.append(el);
  while (toastsEl.childElementCount > TUNE.toastMax) toastsEl.firstElementChild.remove();
  if (k === 'danger') sfx('error');
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 450); }, Math.max(1200, Number(ms) || 2600));
  return el;
}

/** Branded unrecoverable error screen with a Reload button (main.js falls back to its own overlay if this throws). */
export function fatal(title, detail) {
  if (!root) throw new Error('[UI/ui] fatal before init');
  document.getElementById('boot')?.remove();
  if (fatalEl) fatalEl.remove();
  const reload = h('button', { type: 'button', class: 'zf-btn zf-btn--primary', html: '<span>Reload</span>' });
  reload.addEventListener('click', () => location.reload());
  const copy = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost', html: '<span>Copy details</span>' });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`${title}\n${detail}`); copy.querySelector('span').textContent = 'Copied'; } catch (e) { copy.querySelector('span').textContent = 'Copy failed'; }
  });
  fatalEl = h('section', { class: 'zf-fatal', role: 'alert' },
    h('div', { class: 'zf-fatal__box' },
      h('div', { class: 'zf-brand', html: `${GLYPH.mark}<span class="zf-brand__name">ZONEFALL</span>` }),
      h('h1', { class: 'zf-fatal__title', text: 'Game stopped' }),
      h('p', { class: 'zf-fatal__where', text: String(title || '') }),
      h('pre', { class: 'zf-fatal__detail', text: String(detail || '') }),
      h('p', { class: 'zf-fatal__note', text: 'The game stopped to avoid running in a broken state. Reloading usually fixes it; if it keeps happening, copy the details for a bug report.' }),
      h('div', { class: 'zf-fatal__actions' }, reload, copy)));
  root.append(fatalEl);
  root.classList.add('has-fatal');
  reload.focus({ preventScroll: true });
}

// ------------------------------------------------------------------------------------------ debug hooks
function exposeDebug() {
  debug.ui = Object.assign(debug.ui || {}, {
    /**
     * Show one screen for tests: 'loading' | 'menu' | 'private' | 'settings' | 'credits' | 'lobby' | 'hud' | 'map' |
     * 'death' | 'spectate' | 'results' | 'pause' | 'pause-settings'. mock: data for the screen (lobby object, death or
     * results info, loading {p, label}). Does not change state.app.
     */
    showScreen(name, mock = {}) {
      menu.hide(); lobby.hide(); screens.hideAll(); map.setBigOpen(false);
      if (name !== 'loading') menu.hideLoading();
      if (name !== 'hud' && name !== 'map' && name !== 'death' && name !== 'spectate' && name !== 'pause' && name !== 'pause-settings') hud.hide();
      switch (name) {
        case 'loading': menu.showLoading(mock.p ?? 0.42, mock.label || 'Models and textures'); break;
        case 'menu': menu.show(); break;
        case 'private': case 'settings': case 'credits': menu.openPanel(name); break;
        case 'lobby': lobby.show(); lobby.render(mock.lobby || mock); break;
        case 'hud': hud.show(); break;
        case 'map': hud.show(); ensureMapImage(); map.setBigOpen(true); break;
        case 'death': hud.show(); screens.showDeath(mock); break;
        case 'spectate': hud.show(); screens.showSpectate(mock.name || 'Viper'); break;
        case 'results': screens.showResults(mock); break;
        case 'pause': hud.show(); screens.showPause(true); break;
        case 'pause-settings': hud.show(); screens.showPauseSettings(); break;
        default: throw new Error(`[UI/ui] unknown screen '${name}'`);
      }
      return name;
    },
    toast, announce: hud.announce, addPing: map.addPing,
    visible() {
      return [...root.querySelectorAll('section, .zf-toasts')].filter((c) => !c.closest('[hidden]') && getComputedStyle(c).display !== 'none').map((c) => c.className.split(' ')[0]);
    },
    keyName: codeName,
    modules: { menu, lobby, hud, map, screens },
  });
}
