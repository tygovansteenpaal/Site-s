// ZONEFALL dev/ui.html stand-in for engine/input.js. Same binding helpers as the PLAYER module (codeLabel, actionLabel,
// captureNext, rebind, resetBindings); held keys are tracked from the DOM so Tab (scoreboard) and M (map) work.
import { BINDINGS, ACTION_LABELS } from '../../../src/config.js';
import { emit } from '../../../src/core/bus.js';

let active = JSON.parse(JSON.stringify(BINDINGS));
const held = new Set();
const pressedQ = new Set();
let frame = new Set();
let capture = null;
let enabled = true;

addEventListener('keydown', (e) => {
  if (capture) { e.preventDefault(); const c = capture; capture = null; c(e.code === 'Escape' ? null : e.code); return; }
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.code === 'Tab') e.preventDefault();
  if (!e.repeat) pressedQ.add(e.code);
  held.add(e.code);
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('mousedown', (e) => { if (capture) { const c = capture; capture = null; c('Mouse' + e.button); } });

export function init() {}
export function update() { frame = new Set(pressedQ); pressedQ.clear(); }
export function down(a) { return enabled && (!!(window.__uiHeld && window.__uiHeld.has(a)) || (active[a] || []).some((c) => held.has(c))); }
export function pressed(a) { return enabled && (active[a] || []).some((c) => frame.has(c)); }
export function released() { return false; }
export function mouse() { return { dx: 0, dy: 0 }; }
export function wheel() { return 0; }
export function lock() {}
export function unlock() {}
export function isLocked() { return !!window.__uiHarnessLocked; }
export function setEnabled(on) { enabled = !!on; }
export function bindings() { return JSON.parse(JSON.stringify(active)); }
export function actionLabel(a) { return ACTION_LABELS[a] || a; }
const NAMES = { Space: 'Space', ShiftLeft: 'L-Shift', ControlLeft: 'L-Ctrl', AltLeft: 'L-Alt', Tab: 'Tab', Escape: 'Esc', Mouse0: 'Mouse 1', Mouse2: 'Mouse 2', Mouse1: 'Mouse 3', WheelUp: 'Wheel Up', WheelDown: 'Wheel Down', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
export function codeLabel(code) {
  if (NAMES[code]) return NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}
export function captureNext() { return new Promise((res) => { capture = res; }); }
export function rebind(action, codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).slice(0, 3);
  for (const a of Object.keys(active)) if (a !== action) active[a] = active[a].filter((c) => !list.includes(c));
  active[action] = list;
  emit('input:bindings', { bindings: bindings() });
  return bindings();
}
export function resetBindings() { active = JSON.parse(JSON.stringify(BINDINGS)); emit('input:bindings', { bindings: bindings() }); return bindings(); }
