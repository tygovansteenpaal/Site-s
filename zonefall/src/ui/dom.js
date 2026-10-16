// ZONEFALL - UI DOM helpers, inline SVG glyphs and key labels. OWNER: UI (internal to src/ui).
// No framework: h() builds elements, glyphs are inline SVG strings (no icon fonts, no emoji), and every interactive
// element gets its hover/click sound through one delegated listener installed by ui.js (wireSounds).
import * as audio from '../engine/audio.js';
import * as input from '../engine/input.js';
import { BINDINGS } from '../config.js';

/**
 * Create an element. attrs: class, text, html, style (object), data (object), on (object of listeners), any other
 * attribute is set with setAttribute (booleans toggle the attribute).
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Element from an HTML string (first element). */
export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Set textContent only when it changed (hot paths). */
export function setText(el, text) {
  const s = String(text);
  if (el.__t !== s) { el.__t = s; el.textContent = s; }
}

/** Toggle a class only when it changed. */
export function setClass(el, cls, on) {
  const k = '__c_' + cls;
  if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); }
}

/** Set a CSS custom property only when it changed (numbers are rounded to 3 decimals). */
export function setVar(el, name, value) {
  const v = typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value);
  const k = '__v_' + name;
  if (el[k] !== v) { el[k] = v; el.style.setProperty(name, v); }
}

/** Set style.transform only when it changed. */
export function setTransform(el, t) {
  if (el.__tf !== t) { el.__tf = t; el.style.transform = t; }
}

/** Show or hide with the hidden attribute (only when it changed). */
export function show(el, on) {
  if (el.__h !== !on) {
    el.__h = !on;
    if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }
}

let lastSfxAt = 0;
/** UI sound, never throws (audio may still be loading). */
export function sfx(name) {
  if (name !== 'hover') lastSfxAt = performance.now();
  try { audio.ui(name); } catch (e) { /* audio not ready or muted: the UI never fails on sound */ }
}

/** Generic click sound for the delegated listener, skipped when a handler already played a specific one. */
export function sfxClick() {
  if (performance.now() - lastSfxAt < 60) return;
  sfx('click');
}

/** Unlock the audio context from a user gesture. */
export function unlockAudio() {
  try { if (!audio.isUnlocked()) audio.unlock(); } catch (e) { /* no audio context yet */ }
}

const CODE_FALLBACK = { Space: 'Space', ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', Tab: 'Tab', Escape: 'Esc',
  Mouse0: 'LMB', Mouse2: 'RMB', Mouse1: 'MMB', WheelUp: 'Wheel', WheelDown: 'Wheel' };

/** Display label of one binding code. */
export function codeName(code) {
  if (!code) return '-';
  if (typeof input.codeLabel === 'function') return input.codeLabel(code);
  if (CODE_FALLBACK[code]) return CODE_FALLBACK[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/** Display label of the first key bound to an action ('interact' -> 'F'). */
export function keyOf(action) {
  let codes = null;
  try { codes = input.bindings()[action]; } catch (e) { codes = null; }
  if (!codes || !codes.length) codes = BINDINGS[action] || [];
  return codeName(codes[0]);
}

/** A keycap element for an action or a literal label. */
export function keycap(actionOrLabel, literal = false) {
  const el = h('span', { class: 'zf-key', 'aria-hidden': 'true' });
  el.dataset.action = literal ? '' : actionOrLabel;
  el.textContent = literal ? actionOrLabel : keyOf(actionOrLabel);
  return el;
}

/** Refresh every keycap under root (after a rebind). */
export function refreshKeycaps(root) {
  for (const el of root.querySelectorAll('.zf-key[data-action]')) {
    if (el.dataset.action) el.textContent = keyOf(el.dataset.action);
  }
}

/** Escape text for innerHTML templates. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** m:ss */
export function clock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

// ------------------------------------------------------------------------------------------ glyphs (inline SVG)
const svg = (vb, body, cls = '') => `<svg class="zf-glyph ${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;

export const GLYPH = {
  mark: svg('0 0 64 64', '<circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" stroke-width="4.5" class="zf-mark-ring"/><path d="M22 23h20L22 41h20" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="miter" stroke-linecap="square"/>', 'zf-mark'),
  alive: svg('0 0 16 16', '<circle cx="8" cy="4.2" r="2.6" fill="currentColor"/><path d="M3.2 15v-3.6c0-2.2 1.9-3.9 4.8-3.9s4.8 1.7 4.8 3.9V15z" fill="currentColor"/>'),
  kills: svg('0 0 16 16', '<circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 0.8v4M8 11.2v4M0.8 8h4M11.2 8h4" stroke="currentColor" stroke-width="1.6"/>'),
  head: svg('0 0 16 16', '<circle cx="8" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.2 12.6h5.6M6 15h4" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="7" r="1.4" fill="currentColor"/>'),
  plate: svg('0 0 16 16', '<path d="M3 2.2h10l1 2.4v6.2L8 14.6 2 10.8V4.6z" fill="currentColor" opacity=".22"/><path d="M3 2.2h10l1 2.4v6.2L8 14.6 2 10.8V4.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'),
  frag: svg('0 0 16 16', '<rect x="6.2" y="1.2" width="3.6" height="2.4" fill="currentColor"/><path d="M10.4 2.4h2.4v3.2" fill="none" stroke="currentColor" stroke-width="1.2"/><ellipse cx="8" cy="9.6" rx="4.6" ry="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.6 9.6h8.8M8 4.8v9.6" stroke="currentColor" stroke-width="1" opacity=".7"/>'),
  skull: svg('0 0 16 16', '<path d="M8 1.4c-3.5 0-6 2.3-6 5.6 0 1.9.9 3.2 2.1 4v2.6h7.8V11c1.2-.8 2.1-2.1 2.1-4 0-3.3-2.5-5.6-6-5.6z" fill="currentColor"/><circle cx="5.6" cy="7.4" r="1.5" fill="#0d0f0e"/><circle cx="10.4" cy="7.4" r="1.5" fill="#0d0f0e"/><path d="M6.8 13.6v-1.6M9.2 13.6v-1.6" stroke="#0d0f0e" stroke-width="1"/>'),
  gas: svg('0 0 16 16', '<path d="M8 1.5l6.5 12.5h-13z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="12" r=".95" fill="currentColor"/>'),
  arrow: svg('0 0 16 16', '<path d="M8 1.5l5 12-5-3-5 3z" fill="currentColor"/>'),
  chevron: svg('0 0 16 16', '<path d="M5 2.5l6 5.5-6 5.5" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  back: svg('0 0 16 16', '<path d="M11 2.5L5 8l6 5.5" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  copy: svg('0 0 16 16', '<rect x="5" y="5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 11V2h9" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  sound: svg('0 0 16 16', '<path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor"/><path d="M11 5.2c1 .8 1.5 1.7 1.5 2.8s-.5 2-1.5 2.8M12.8 3.4c1.5 1.2 2.3 2.8 2.3 4.6s-.8 3.4-2.3 4.6" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  muted: svg('0 0 16 16', '<path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor"/><path d="M11 5.5l4 5M15 5.5l-4 5" stroke="currentColor" stroke-width="1.4"/>'),
  host: svg('0 0 16 16', '<path d="M2 12.5h12l1-8-4 3L8 2 5 7.5l-4-3z" fill="currentColor"/>'),
  bot: svg('0 0 16 16', '<rect x="2.5" y="5" width="11" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 5V2.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5.8" cy="9" r="1.1" fill="currentColor"/><circle cx="10.2" cy="9" r="1.1" fill="currentColor"/>'),
  signal: svg('0 0 16 16', '<rect x="1.5" y="10" width="2.6" height="4.5" fill="currentColor"/><rect x="5.5" y="7" width="2.6" height="7.5" fill="currentColor"/><rect x="9.5" y="4" width="2.6" height="10.5" fill="currentColor"/><rect x="13.3" y="1.5" width="1.4" height="13" fill="currentColor" opacity=".35"/>'),
  ammo: svg('0 0 16 16', '<path d="M6 15V6.5L8 1.5l2 5V15z" fill="currentColor"/><path d="M6 12.2h4" stroke="#0d0f0e" stroke-width=".9"/>'),
  plane: svg('0 0 16 16', '<path d="M8 1c.8 0 1.2.9 1.2 2v3.4l5.3 3.1v1.6L9.2 9.6v3l1.8 1.3V15L8 14.2 5 15v-1.1l1.8-1.3v-3L1.5 11.1V9.5l5.3-3.1V3C6.8 1.9 7.2 1 8 1z" fill="currentColor"/>'),
};
