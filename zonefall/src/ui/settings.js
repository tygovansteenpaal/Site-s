// ZONEFALL - settings panel (used by the menu and the pause overlay). OWNER: UI. Contract: ARCHITECTURE.md 9.
// Bound to core/settings get/set: callsign, mouse sensitivity, ADS sensitivity, field of view (horizontal), invert Y,
// graphics quality (Auto/Low/Medium/High with the auto-detected tier named), master/effects/interface/ambience volume,
// mute, show FPS, and the controls list from input.bindings() with ACTION_LABELS. Keys can be rebound through the
// PLAYER input additions (captureNext/rebind/resetBindings) when they exist. Every change applies live.
import { on, EV } from '../core/bus.js';
import * as settings from '../core/settings.js';
import { state } from '../core/state.js';
import { SETTINGS_LIMITS, ACTION_LABELS, QUALITY_NAMES } from '../config.js';
import * as input from '../engine/input.js';
import * as renderer from '../engine/renderer.js';
import { h, sfx, codeName, esc } from './dom.js';

const TABS = [
  ['gameplay', 'Gameplay'],
  ['graphics', 'Graphics'],
  ['audio', 'Audio'],
  ['controls', 'Controls'],
];

/** Order and grouping of the controls list. */
const CONTROL_GROUPS = [
  ['Movement', ['forward', 'back', 'left', 'right', 'jump', 'crouch', 'sprint']],
  ['Combat', ['fire', 'ads', 'reload', 'slot1', 'slot2', 'swap', 'grenade', 'plate']],
  ['Interface', ['interact', 'map', 'scoreboard', 'pause', 'freelook']],
];

const QUALITY_TEXT = {
  low: 'Shadows 1024, no post effects, 520 m view distance',
  medium: 'Shadows 2048, SMAA, bloom, 900 m view distance',
  high: 'Shadows 4096, ambient occlusion, 1300 m view distance',
};

let detected = null;
function detectedTier() {
  if (detected) return detected;
  try { detected = renderer.detectTier(); } catch (e) { detected = state.quality || 'medium'; }
  return detected;
}

function slider(key, label, { min, max, step, fmt }) {
  const id = 'zf-set-' + key + '-' + Math.random().toString(36).slice(2, 7);
  const out = h('output', { class: 'zf-set__val', for: id });
  const inp = h('input', { type: 'range', id, min, max, step, class: 'zf-range' });
  const paint = () => {
    const v = Number(inp.value);
    inp.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(2) + '%');
    out.textContent = fmt(v);
  };
  inp.addEventListener('input', () => { settings.set(key, Number(inp.value)); paint(); });
  inp.addEventListener('change', () => sfx('tick'));
  const row = h('div', { class: 'zf-set__row' },
    h('label', { class: 'zf-set__label', for: id, text: label }),
    h('div', { class: 'zf-set__ctl' }, inp, out));
  return { row, refresh() { inp.value = settings.get(key); paint(); } };
}

function toggle(key, label, hint) {
  const btn = h('button', { type: 'button', class: 'zf-toggle', role: 'switch', 'aria-label': label },
    h('span', { class: 'zf-toggle__track' }, h('span', { class: 'zf-toggle__knob' })),
    h('span', { class: 'zf-toggle__txt' }));
  btn.addEventListener('click', () => { settings.set(key, !settings.get(key)); refresh(); });
  const row = h('div', { class: 'zf-set__row' },
    h('div', { class: 'zf-set__label' }, label, hint ? h('small', { text: hint }) : null),
    h('div', { class: 'zf-set__ctl' }, btn));
  function refresh() {
    const v = !!settings.get(key);
    btn.setAttribute('aria-checked', String(v));
    btn.querySelector('.zf-toggle__txt').textContent = v ? 'On' : 'Off';
  }
  return { row, refresh };
}

/** Build the panel into container; returns {el, refresh()}. */
export function mountSettings(container) {
  const refreshers = [];
  const pct = (v) => Math.round(v * 100) + '%';

  // ---- gameplay
  const nameIn = h('input', { type: 'text', class: 'zf-input zf-input--mono', maxlength: 16, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Callsign' });
  nameIn.addEventListener('change', () => { nameIn.value = settings.set('name', nameIn.value) || settings.get('name'); });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); e.stopPropagation(); });
  refreshers.push(() => { if (document.activeElement !== nameIn) nameIn.value = settings.get('name'); });

  const sens = slider('sensitivity', 'Mouse sensitivity', { min: SETTINGS_LIMITS.sensitivity[0], max: SETTINGS_LIMITS.sensitivity[1], step: 0.05, fmt: (v) => v.toFixed(2) });
  const adsSens = slider('adsSensitivity', 'Aim sensitivity multiplier', { min: SETTINGS_LIMITS.adsSensitivity[0], max: SETTINGS_LIMITS.adsSensitivity[1], step: 0.05, fmt: (v) => v.toFixed(2) + 'x' });
  const fov = slider('fov', 'Field of view (horizontal)', { min: SETTINGS_LIMITS.fov[0], max: SETTINGS_LIMITS.fov[1], step: 1, fmt: (v) => v + '°' });
  const invert = toggle('invertY', 'Invert vertical look');
  refreshers.push(sens.refresh, adsSens.refresh, fov.refresh, invert.refresh);

  const gameplay = h('div', { class: 'zf-set__page', data: { page: 'gameplay' } },
    h('div', { class: 'zf-set__row' }, h('label', { class: 'zf-set__label', text: 'Callsign' }), h('div', { class: 'zf-set__ctl' }, nameIn)),
    sens.row, adsSens.row, fov.row, invert.row);

  // ---- graphics
  const seg = h('div', { class: 'zf-seg', role: 'radiogroup', 'aria-label': 'Graphics quality' });
  const segBtns = {};
  for (const v of ['auto', ...QUALITY_NAMES]) {
    const b = h('button', { type: 'button', class: 'zf-seg__btn', role: 'radio', data: { v } }, v === 'auto' ? 'Auto' : v[0].toUpperCase() + v.slice(1));
    b.addEventListener('click', () => { settings.set('quality', v); refreshGraphics(); });
    segBtns[v] = b;
    seg.append(b);
  }
  const qNote = h('p', { class: 'zf-set__note' });
  const stats = h('p', { class: 'zf-set__stats' });
  const fps = toggle('showFps', 'Show frame rate', 'Top-left corner during a match');
  refreshers.push(fps.refresh);
  function refreshGraphics() {
    const cur = settings.get('quality');
    for (const [v, b] of Object.entries(segBtns)) {
      b.setAttribute('aria-checked', String(v === cur));
      b.classList.toggle('is-on', v === cur);
    }
    const det = detectedTier();
    const active = cur === 'auto' ? det : cur;
    qNote.innerHTML = `<b>${esc(active.toUpperCase())}</b> ${esc(QUALITY_TEXT[active] || '')}` +
      (cur === 'auto' ? `<span>Auto picked ${esc(det.toUpperCase())} for this device.</span>` : `<span>Detected tier for this device: ${esc(det.toUpperCase())}.</span>`);
  }
  refreshers.push(refreshGraphics);
  const graphics = h('div', { class: 'zf-set__page', data: { page: 'graphics' } },
    h('div', { class: 'zf-set__row zf-set__row--stack' }, h('div', { class: 'zf-set__label', text: 'Quality' }), seg, qNote),
    fps.row, stats);

  // ---- audio
  const master = slider('masterVolume', 'Master volume', { min: 0, max: 1, step: 0.01, fmt: pct });
  const sfxVol = slider('sfxVolume', 'Effects', { min: 0, max: 1, step: 0.01, fmt: pct });
  const uiVol = slider('uiVolume', 'Interface', { min: 0, max: 1, step: 0.01, fmt: pct });
  const amb = slider('ambienceVolume', 'Ambience', { min: 0, max: 1, step: 0.01, fmt: pct });
  const mute = toggle('muted', 'Mute all sound');
  refreshers.push(master.refresh, sfxVol.refresh, uiVol.refresh, amb.refresh, mute.refresh);
  const audioPage = h('div', { class: 'zf-set__page', data: { page: 'audio' } }, master.row, sfxVol.row, uiVol.row, amb.row, mute.row);

  // ---- controls
  const canRebind = typeof input.captureNext === 'function' && typeof input.rebind === 'function';
  const ctlList = h('div', { class: 'zf-binds' });
  const ctlNote = h('p', { class: 'zf-set__note', text: canRebind ? 'Select a binding, then press the new key or mouse button. Esc cancels.' : 'Current key bindings.' });
  let capturing = null;
  function renderControls() {
    let map = {};
    try { map = input.bindings(); } catch (e) { map = {}; }
    ctlList.textContent = '';
    for (const [group, actions] of CONTROL_GROUPS) {
      ctlList.append(h('div', { class: 'zf-binds__group', text: group }));
      for (const a of actions) {
        if (!(a in map) && !(a in ACTION_LABELS)) continue;
        const label = typeof input.actionLabel === 'function' ? input.actionLabel(a) : (ACTION_LABELS[a] || a);
        const codes = map[a] || [];
        const keys = h('span', { class: 'zf-binds__keys' });
        for (const c of codes.length ? codes : [null]) keys.append(h('span', { class: 'zf-key' + (c ? '' : ' is-empty'), text: c ? codeName(c) : 'Unbound' }));
        const row = canRebind
          ? h('button', { type: 'button', class: 'zf-binds__row', data: { action: a }, 'aria-label': `Rebind ${label}` }, h('span', { class: 'zf-binds__name', text: label }), keys)
          : h('div', { class: 'zf-binds__row' }, h('span', { class: 'zf-binds__name', text: label }), keys);
        if (canRebind) row.addEventListener('click', () => beginCapture(a, row));
        ctlList.append(row);
      }
    }
  }
  async function beginCapture(action, row) {
    if (capturing) return;
    capturing = action;
    row.classList.add('is-capturing');
    row.querySelector('.zf-binds__keys').innerHTML = '<span class="zf-key is-live">Press a key</span>';
    let code = null;
    try { code = await input.captureNext(); } catch (e) { code = null; }
    capturing = null;
    if (code) {
      try { input.rebind(action, [code]); sfx('confirm'); } catch (e) { sfx('error'); }
    } else sfx('back');
    renderControls();
  }
  const resetBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost zf-btn--sm', text: 'Reset to defaults' });
  resetBtn.addEventListener('click', () => {
    if (typeof input.resetBindings === 'function') input.resetBindings();
    renderControls();
  });
  const controls = h('div', { class: 'zf-set__page', data: { page: 'controls' } }, ctlNote, ctlList, canRebind ? resetBtn : null);
  refreshers.push(renderControls);

  // ---- shell with tabs
  const tabBar = h('div', { class: 'zf-tabs', role: 'tablist' });
  const pages = { gameplay, graphics, audio: audioPage, controls };
  const tabBtns = {};
  let current = 'gameplay';
  function select(id) {
    current = id;
    for (const [k, b] of Object.entries(tabBtns)) { b.setAttribute('aria-selected', String(k === id)); b.classList.toggle('is-on', k === id); }
    for (const [k, p] of Object.entries(pages)) p.hidden = k !== id;
  }
  TABS.forEach(([id, label], i) => {
    const b = h('button', { type: 'button', class: 'zf-tabs__btn', role: 'tab' }, h('span', { class: 'zf-tabs__idx', text: String(i + 1).padStart(2, '0') }), label);
    b.addEventListener('click', () => select(id));
    tabBtns[id] = b;
    tabBar.append(b);
  });
  const el = h('div', { class: 'zf-settings' }, tabBar, h('div', { class: 'zf-set__body' }, gameplay, graphics, audioPage, controls));
  container.append(el);
  select(current);

  function refresh() {
    for (const r of refreshers) r();
    try {
      const s = renderer.stats();
      stats.textContent = `Now rendering: ${String(s.tier || state.quality).toUpperCase()} tier, ${s.fps} fps, ${s.ms} ms, ${s.calls} draw calls, pixel ratio ${s.dpr}`;
    } catch (e) { stats.textContent = ''; }
  }
  on(EV.SETTINGS_CHANGED, () => { if (el.isConnected && !el.closest('[hidden]')) refresh(); });
  on(EV.QUALITY_CHANGED, () => { if (el.isConnected) refresh(); });
  on('input:bindings', () => { if (el.isConnected && !capturing) renderControls(); });
  refresh();
  return { el, refresh, select };
}
