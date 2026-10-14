// ZONEFALL - keyboard/mouse (+ optional gamepad) input with rebindable action bindings.
// OWNER: PLAYER. Contract: ARCHITECTURE.md 5.2.
// Actions are the keys of config.BINDINGS plus the PLAYER extras below (shoulder swap, view toggle). Codes are
// KeyboardEvent.code values, 'Mouse0'/'Mouse1'/'Mouse2'/'Mouse3'/'Mouse4' and 'WheelUp'/'WheelDown'.
// Edges are latched once per frame by update(), so a press and release inside one frame still reads as pressed.
// Physical keyboard/mouse actions count only while the pointer is locked (or setAllowUnlocked(true) in dev pages);
// pressing a 'pause' key while locked releases the lock, which main.js and the UI treat as "open the pause menu".
// Bindings are persisted per browser under STORAGE_KEY; rebind()/resetBindings()/captureNext() serve the settings UI.
import { BINDINGS, ACTION_LABELS } from '../config.js';
import { emit, on, EV, registerEvents } from '../core/bus.js';
import { state, debug, APP } from '../core/state.js';
import { storage } from '../core/util.js';

// ------------------------------------------------------------------------------------------ tunables
const TUNE = {
  // PLAYER-only actions (not in config.BINDINGS). Defaults chosen from keys config leaves free.
  extraBindings: { shoulder: ['KeyQ'], view: ['KeyV'] },
  extraLabels: { shoulder: 'Swap shoulder', view: 'First / third person' },
  mouseSpikePx: 600,          // Chrome occasionally reports a huge movementX after lock; ignore single-event spikes
  padDeadzone: 0.16,
  padTrigger: 0.35,
  padLookRate: 3.4,           // rad/s at full right-stick deflection (sensitivity 1.0), applied by camera.look via stick('look')
};
const STORAGE_KEY = 'zonefall.bindings.v1';

/** PLAYER input events. BINDINGS {bindings: {action: codes[]}} after rebind() or resetBindings(). */
export const IEV = registerEvents({ BINDINGS: 'input:bindings' });

// Standard-mapping gamepad buttons -> actions.
const PAD_BUTTONS = {
  0: ['jump'], 1: ['crouch'], 2: ['reload'], 3: ['swap'], 4: ['interact'], 5: ['grenade'],
  10: ['sprint'], 11: ['shoulder'], 12: ['plate'], 13: ['view'], 14: ['slot1'], 15: ['slot2'], 8: ['map'], 9: ['pause'],
};

// ------------------------------------------------------------------------------------------ state
const DEFAULTS = Object.freeze({ ...cloneMap(BINDINGS), ...cloneMap(TUNE.extraBindings) });
let active = loadBindings();          // action -> codes[]
let codeToActions = buildReverse(active);

const held = new Set();               // codes physically down right now
const pressQ = new Set();             // codes that went down since the last update()
const releaseQ = new Set();
const framePressed = new Set();       // latched for the current frame
const frameReleased = new Set();

const virtualHeld = new Set();        // test/automation hooks: actions held regardless of lock
const virtualPressQ = new Set();
const virtualReleaseQ = new Set();
const vPressed = new Set();
const vReleased = new Set();

const padHeld = new Set();            // actions held on the gamepad this frame
const padPrev = new Set();
const padPressed = new Set();
const padReleased = new Set();
const padMove = { x: 0, y: 0 };
const padLook = { x: 0, y: 0 };
let padIndex = -1;
let padLT = 0, padRT = 0;

let mouseAccX = 0, mouseAccY = 0, mouseDX = 0, mouseDY = 0;
let virtualDX = 0, virtualDY = 0;
let wheelAcc = 0, wheelFrame = 0;

let canvasEl = null;
let enabled = true;
let locked = false;
let allowUnlocked = false;
let lastDevice = 'kbm';
let capture = null;                   // {resolve, reject} while the settings UI waits for a key
let initDone = false;

const tmpMove = { x: 0, y: 0 };

function cloneMap(m) {
  const out = {};
  for (const k of Object.keys(m)) out[k] = [...m[k]];
  return out;
}

function loadBindings() {
  const saved = storage.get(STORAGE_KEY, null);
  const map = cloneMap(DEFAULTS);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(map)) {
      const v = saved[k];
      if (Array.isArray(v) && v.every((c) => typeof c === 'string' && c.length < 32)) map[k] = v.slice(0, 3);
    }
  }
  return map;
}

function buildReverse(map) {
  const rev = new Map();
  for (const [action, codes] of Object.entries(map)) {
    for (const c of codes) {
      if (!rev.has(c)) rev.set(c, []);
      rev.get(c).push(action);
    }
  }
  return rev;
}

function isGameCode(code) { return codeToActions.has(code); }

function physicalActive() { return enabled && (locked || allowUnlocked); }

// ------------------------------------------------------------------------------------------ DOM listeners
function onKeyDown(e) {
  if (capture) { e.preventDefault(); finishCapture(e.code); return; }
  if (isTextTarget(e.target)) return;
  lastDevice = 'kbm';
  const code = e.code;
  if (!code) return;
  if (locked && isGameCode(code)) e.preventDefault();
  else if (locked && (code === 'AltLeft' || code === 'AltRight' || code === 'Tab')) e.preventDefault();
  if (e.repeat) return;
  if (!held.has(code)) { held.add(code); pressQ.add(code); }
  if (locked && actionOfCode(code, 'pause')) unlock();
}

function onKeyUp(e) {
  const code = e.code;
  if (!code) return;
  if (locked && isGameCode(code)) e.preventDefault();
  if (held.delete(code)) releaseQ.add(code);
}

function onMouseDown(e) {
  if (capture) { e.preventDefault(); finishCapture('Mouse' + e.button); return; }
  lastDevice = 'kbm';
  const code = 'Mouse' + e.button;
  if (!locked) {
    // The click that requests the lock must not fire the weapon.
    if (e.target === canvasEl && enabled && state.app === APP.MATCH && !allowUnlocked) { lock(); return; }
    if (!allowUnlocked || e.target !== canvasEl) return;
  }
  e.preventDefault();
  if (!held.has(code)) { held.add(code); pressQ.add(code); }
}

function onMouseUp(e) {
  const code = 'Mouse' + e.button;
  if (held.delete(code)) releaseQ.add(code);
}

function onMouseMove(e) {
  if (!locked) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(dx) > TUNE.mouseSpikePx || Math.abs(dy) > TUNE.mouseSpikePx) return;
  mouseAccX += dx;
  mouseAccY += dy;
  if (dx || dy) lastDevice = 'kbm';
}

function onWheel(e) {
  if (capture) { e.preventDefault(); finishCapture(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'); return; }
  if (!locked && !(allowUnlocked && e.target === canvasEl)) return;
  e.preventDefault();
  const step = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
  if (!step) return;
  wheelAcc += step;
  const code = step > 0 ? 'WheelDown' : 'WheelUp';
  pressQ.add(code);
  releaseQ.add(code);
}

function onContextMenu(e) { if (e.target === canvasEl) e.preventDefault(); }

function onLockChange() {
  const now = !!canvasEl && document.pointerLockElement === canvasEl;
  if (now === locked) return;
  locked = now;
  if (!locked) clearHeld();
  emit(EV.INPUT_LOCK, { locked });
}

function onLockError() {
  locked = false;
  emit(EV.INPUT_LOCK, { locked: false });
}

function onBlur() { clearHeld(); }

function isTextTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function clearHeld() {
  for (const c of held) releaseQ.add(c);
  held.clear();
  mouseAccX = mouseAccY = 0;
}

function actionOfCode(code, action) {
  const list = codeToActions.get(code);
  return !!list && list.includes(action);
}

// ------------------------------------------------------------------------------------------ gamepad
function pollGamepad() {
  padPrev.clear();
  for (const a of padHeld) padPrev.add(a);
  padHeld.clear();
  padPressed.clear();
  padReleased.clear();
  padMove.x = padMove.y = padLook.x = padLook.y = 0;
  padLT = padRT = 0;
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  let pad = null;
  const pads = navigator.getGamepads();
  if (padIndex >= 0 && pads[padIndex] && pads[padIndex].connected) pad = pads[padIndex];
  else {
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected && pads[i].mapping === 'standard') { pad = pads[i]; padIndex = i; break; }
  }
  if (!pad || !enabled) return;
  const ax = pad.axes;
  deadzone(ax[0] || 0, ax[1] || 0, padMove);
  deadzone(ax[2] || 0, ax[3] || 0, padLook);
  const b = pad.buttons;
  padLT = b[6] ? b[6].value : 0;
  padRT = b[7] ? b[7].value : 0;
  if (padLT > TUNE.padTrigger) padHeld.add('ads');
  if (padRT > TUNE.padTrigger) padHeld.add('fire');
  for (const [idx, actions] of Object.entries(PAD_BUTTONS)) {
    const btn = b[idx];
    if (btn && btn.pressed) for (const a of actions) padHeld.add(a);
  }
  // Left stick as digital directions too, so code reading down('forward') works with a pad.
  if (padMove.y < -0.3) padHeld.add('forward');
  if (padMove.y > 0.3) padHeld.add('back');
  if (padMove.x < -0.3) padHeld.add('left');
  if (padMove.x > 0.3) padHeld.add('right');
  for (const a of padHeld) if (!padPrev.has(a)) padPressed.add(a);
  for (const a of padPrev) if (!padHeld.has(a)) padReleased.add(a);
  if (padHeld.size || Math.abs(padLook.x) + Math.abs(padLook.y) + Math.abs(padMove.x) + Math.abs(padMove.y) > 0) lastDevice = 'pad';
}

function deadzone(x, y, out) {
  const m = Math.hypot(x, y);
  if (m < TUNE.padDeadzone) { out.x = out.y = 0; return; }
  const k = Math.min(1, (m - TUNE.padDeadzone) / (1 - TUNE.padDeadzone)) / m;
  out.x = x * k;
  out.y = y * k;
}

// ------------------------------------------------------------------------------------------ public API
/** Attach listeners to the canvas and window. */
export function init(canvas) {
  if (initDone) return;
  initDone = true;
  canvasEl = canvas;
  addEventListener('keydown', onKeyDown, { capture: true });
  addEventListener('keyup', onKeyUp, { capture: true });
  addEventListener('mousedown', onMouseDown);
  addEventListener('mouseup', onMouseUp);
  addEventListener('mousemove', onMouseMove);
  addEventListener('wheel', onWheel, { passive: false });
  addEventListener('blur', onBlur);
  addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);
  addEventListener('gamepadconnected', (e) => { if (e.gamepad && e.gamepad.mapping === 'standard') padIndex = e.gamepad.index; });
  addEventListener('gamepaddisconnected', (e) => { if (e.gamepad && e.gamepad.index === padIndex) padIndex = -1; });
  on(EV.APP_STATE, ({ to }) => { if (to !== APP.MATCH && locked) unlock(); });
  debug.player = debug.player || {};
  Object.assign(debug.player, {
    press: (action) => { virtualPressQ.add(action); virtualReleaseQ.add(action); },
    hold: (action, on = true) => { if (on) { if (!virtualHeld.has(action)) { virtualHeld.add(action); virtualPressQ.add(action); } } else if (virtualHeld.delete(action)) virtualReleaseQ.add(action); },
    releaseAll: () => { for (const a of virtualHeld) virtualReleaseQ.add(a); virtualHeld.clear(); },
    look: (dx, dy) => { virtualDX += dx; virtualDY += dy; },
  });
}

function moveSet(from, to) {
  to.clear();
  for (const v of from) to.add(v);
  from.clear();
}

/** Call once at the very start of every frame: latches pressed/released edges and mouse/wheel deltas for this frame. */
export function update() {
  moveSet(pressQ, framePressed);
  moveSet(releaseQ, frameReleased);
  moveSet(virtualPressQ, vPressed);
  moveSet(virtualReleaseQ, vReleased);
  mouseDX = (locked ? mouseAccX : 0) + virtualDX;
  mouseDY = (locked ? mouseAccY : 0) + virtualDY;
  mouseAccX = mouseAccY = 0;
  virtualDX = virtualDY = 0;
  wheelFrame = locked || allowUnlocked ? wheelAcc : 0;
  wheelAcc = 0;
  pollGamepad();
}

/** Held this frame. */
export function down(action) {
  if (!enabled) return false;
  if (virtualHeld.has(action) || vPressed.has(action) || padHeld.has(action)) return true;
  if (!physicalActive()) return false;
  const codes = active[action];
  if (!codes) return false;
  for (const c of codes) if (held.has(c) || framePressed.has(c)) return true;
  return false;
}

/** Went down this frame (edge). */
export function pressed(action) {
  if (!enabled) return false;
  if (vPressed.has(action) || padPressed.has(action)) return true;
  if (!physicalActive()) return false;
  const codes = active[action];
  if (!codes) return false;
  for (const c of codes) if (framePressed.has(c)) return true;
  return false;
}

/** Went up this frame (edge). */
export function released(action) {
  if (!enabled) return false;
  if (vReleased.has(action) || padReleased.has(action)) return true;
  if (!physicalActive()) return false;
  const codes = active[action];
  if (!codes) return false;
  for (const c of codes) if (frameReleased.has(c)) return true;
  return false;
}

/** Raw mouse movement this frame in CSS pixels {dx, dy} (0 when the pointer is not locked). */
const mouseOut = { dx: 0, dy: 0 };
export function mouse() {
  mouseOut.dx = enabled ? mouseDX : 0;
  mouseOut.dy = enabled ? mouseDY : 0;
  return mouseOut;
}

/** Wheel steps this frame: +1 per notch down/away, -1 up/toward. */
export function wheel() { return enabled ? wheelFrame : 0; }

export function lock() {
  if (!canvasEl || locked || typeof canvasEl.requestPointerLock !== 'function') return;
  try {
    const p = canvasEl.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // Raw input is unsupported on some platforms: retry with OS acceleration. Re-lock right after Escape is
        // refused by the browser for about a second; the pause overlay's resume button simply tries again.
        if (err && err.name === 'NotSupportedError') {
          const p2 = canvasEl.requestPointerLock();
          if (p2 && typeof p2.catch === 'function') p2.catch(() => onLockError());
        } else onLockError();
      });
    }
  } catch (err) {
    onLockError();
  }
}

export function unlock() {
  if (document.pointerLockElement) document.exitPointerLock();
}

export function isLocked() { return locked; }

/** Disable all game actions (menus open); down/pressed return false while disabled. */
export function setEnabled(on) {
  on = !!on;
  if (enabled === on) return;
  enabled = on;
  if (!enabled) { clearHeld(); framePressed.clear(); frameReleased.clear(); }
}

/** Active bindings {action: [codes]} (config.BINDINGS plus PLAYER extras; read by the UI controls list). */
export function bindings() { return cloneMap(active); }

// ------------------------------------------------------------------------------------------ additions (PLAYER)
/** Human label of an action (config.ACTION_LABELS plus the PLAYER extras). */
export function actionLabel(action) { return ACTION_LABELS[action] || TUNE.extraLabels[action] || action; }

const CODE_NAMES = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Mouse0: 'Mouse 1', Mouse1: 'Mouse 3', Mouse2: 'Mouse 2', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  WheelUp: 'Wheel Up', WheelDown: 'Wheel Down',
};
/** Short display name of a binding code ('KeyW' -> 'W', 'Mouse2' -> 'Mouse 2'). */
export function codeLabel(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
  if (/^F\d+$/.test(code)) return code;
  return code;
}

/** Replace the codes of one action (max 3). Removes those codes from other actions to avoid double bindings. */
export function rebind(action, codes) {
  if (!(action in active)) throw new Error(`[PLAYER/input] unknown action '${action}'`);
  const list = (Array.isArray(codes) ? codes : [codes]).filter((c) => typeof c === 'string' && c).slice(0, 3);
  for (const [a, cs] of Object.entries(active)) {
    if (a === action) continue;
    // Movement keys may legitimately share nothing; swap and the wheel are the only intended multi-code action.
    active[a] = cs.filter((c) => !list.includes(c));
  }
  active[action] = list;
  codeToActions = buildReverse(active);
  storage.set(STORAGE_KEY, active);
  emit(IEV.BINDINGS, { bindings: cloneMap(active) });
  return cloneMap(active);
}

/** Restore every binding to the defaults. */
export function resetBindings() {
  active = cloneMap(DEFAULTS);
  codeToActions = buildReverse(active);
  storage.set(STORAGE_KEY, active);
  emit(IEV.BINDINGS, { bindings: cloneMap(active) });
  return cloneMap(active);
}

/** Resolve with the next key/button/wheel code pressed (settings rebind flow). Escape cancels (resolves null). */
export function captureNext() {
  if (capture) capture.resolve(null);
  return new Promise((resolve) => { capture = { resolve }; });
}
function finishCapture(code) {
  const c = capture;
  capture = null;
  c.resolve(code === 'Escape' ? null : code);
}

/** Analog sticks with deadzone applied: 'move' (x right, y down) or 'look'. Zero without a pad. */
const stickOut = { x: 0, y: 0 };
export function stick(name) {
  const src = name === 'look' ? padLook : padMove;
  stickOut.x = enabled ? src.x : 0;
  stickOut.y = enabled ? src.y : 0;
  return stickOut;
}

/**
 * Combined movement intent in [-1, 1]: x = strafe right, y = forward. Keyboard is digital, the pad is analog;
 * the result is clipped to the unit circle so diagonals are not faster.
 */
export function moveAxes(out = tmpMove) {
  let x = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
  let y = (down('forward') ? 1 : 0) - (down('back') ? 1 : 0);
  if (Math.abs(padMove.x) > 0.01 || Math.abs(padMove.y) > 0.01) { x = padMove.x; y = -padMove.y; }
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  out.x = x;
  out.y = y;
  return out;
}

/** Right-stick look rate in rad/s at sensitivity 1 (camera multiplies by stick('look') and dt). */
export function padLookRate() { return TUNE.padLookRate; }

/** 'kbm' or 'pad': the device that produced the latest input (prompts can show the right glyphs). */
export function device() { return lastDevice; }

/** Dev pages without pointer lock (and automated tests) may read physical input while unlocked. */
export function setAllowUnlocked(on) { allowUnlocked = !!on; }
