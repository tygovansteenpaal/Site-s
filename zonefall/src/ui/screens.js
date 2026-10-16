// ZONEFALL - death, spectate, results and pause overlays. OWNER: UI. Contract: ARCHITECTURE.md 9.
// Death: "ELIMINATED" + killer name, weapon, headshot, distance (state.local.killer), placement, kills, damage;
// buttons SPECTATE / LEAVE MATCH (with key hints, because the pointer is usually still locked). Spectating bar: target
// name with their health and armor, previous/next, LEAVE MATCH. Results (state.app 'results'): VICTORY ("LAST ONE
// STANDING") or placement, kills, damage, headshots, longest kill, time survived; PLAY AGAIN (same mode) / MAIN MENU.
// Pause (Escape / lost pointer lock): RESUME, SETTINGS, LEAVE MATCH; practice mode freezes the simulation
// (main.js handles UI_INTENT 'pause'/'resume'; RESUME requests pointer lock from its click).
import { emit, EV } from '../core/bus.js';
import { state, getPlayer } from '../core/state.js';
import { WEAPONS, MATCH, PLAYER } from '../config.js';
import { h, sfx, GLYPH, keycap, setText, setVar, clock } from './dom.js';
import { mountSettings } from './settings.js';

let root = null;
let deathEl, specEl, resultsEl, pauseEl;
let specName, specHp, specArmor, specTargetId = null;
let pauseSettings = null, pauseSide, pauseRef, leaveArmed = 0, leaveBtn;
const open = { death: false, spectate: false, results: false, pause: false };

const weaponName = (w) => (WEAPONS[w] ? WEAPONS[w].name : w === 'zone' ? 'The zone' : w === 'fall' ? 'Fall damage' : w === 'frag' ? 'Frag grenade' : w ? String(w).toUpperCase() : 'Unknown');
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function btn(label, cls, onClick, glyph = null) {
  const b = h('button', { type: 'button', class: 'zf-btn ' + cls, html: (glyph || '') + '<span></span>' });
  b.querySelector('span').textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function buildDeath() {
  deathEl = h('section', { class: 'zf-death', hidden: true, 'aria-label': 'Eliminated', role: 'dialog' });
  root.append(deathEl);
}

function buildSpectate() {
  specName = h('b', { class: 'zf-spec__name' });
  specHp = h('i', { class: 'zf-spec__hp' });
  specArmor = h('i', { class: 'zf-spec__armor' });
  const prev = h('button', { type: 'button', class: 'zf-spec__nav', 'aria-label': 'Previous player', html: GLYPH.back });
  prev.addEventListener('click', () => emit(EV.UI_INTENT, { type: 'spectate_prev' }));
  const next = h('button', { type: 'button', class: 'zf-spec__nav', 'aria-label': 'Next player', html: GLYPH.chevron });
  next.addEventListener('click', () => emit(EV.UI_INTENT, { type: 'spectate_next' }));
  const leave = btn('Leave match', 'zf-btn--ghost zf-btn--sm', () => { sfx('back'); emit(EV.UI_INTENT, { type: 'leave_match' }); });
  specEl = h('section', { class: 'zf-spec', hidden: true, 'aria-label': 'Spectating' },
    h('div', { class: 'zf-spec__bar' },
      prev,
      h('div', { class: 'zf-spec__who' }, h('span', { class: 'zf-label', text: 'Spectating' }), specName,
        h('span', { class: 'zf-spec__vitals' }, h('span', { class: 'zf-spec__track zf-spec__track--armor' }, specArmor), h('span', { class: 'zf-spec__track' }, specHp))),
      next),
    h('div', { class: 'zf-spec__keys' },
      h('span', null, keycap('left'), keycap('right'), ' Switch player'),
      h('span', null, keycap('pause'), ' Menu'),
      leave));
  root.append(specEl);
}

function buildResults() {
  resultsEl = h('section', { class: 'zf-results', hidden: true, 'aria-label': 'Match results', role: 'dialog' });
  root.append(resultsEl);
}

function buildPause() {
  const resume = btn('Resume', 'zf-btn--primary', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'resume' }); }, '');
  const settingsBtn = btn('Settings', 'zf-btn--solid', () => togglePauseSettings());
  leaveBtn = btn('Leave match', 'zf-btn--ghost zf-btn--danger', () => {
    const now = performance.now();
    if (now - leaveArmed < 3000) { sfx('back'); leaveArmed = 0; emit(EV.UI_INTENT, { type: 'leave_match' }); return; }
    leaveArmed = now;
    sfx('error');
    leaveBtn.querySelector('span').textContent = 'Click again to leave';
    setTimeout(() => { if (performance.now() - leaveArmed >= 2900) leaveBtn.querySelector('span').textContent = 'Leave match'; }, 3000);
  });
  pauseRef = h('div', { class: 'zf-pause__ref' });
  pauseSide = h('div', { class: 'zf-pause__side' }, pauseRef);
  pauseEl = h('section', { class: 'zf-pause', hidden: true, 'aria-label': 'Paused', role: 'dialog' },
    h('div', { class: 'zf-pause__scrim' }),
    h('div', { class: 'zf-pause__main' },
      h('p', { class: 'zf-eyebrow', 'data-pk': '' }),
      h('h1', { class: 'zf-pause__title', 'data-pt': '' }),
      h('p', { class: 'zf-pause__note', 'data-pn': '' }),
      h('div', { class: 'zf-pause__actions' }, resume, settingsBtn, leaveBtn)),
    pauseSide);
  root.append(pauseEl);
  buildControlsRef();
}

function buildControlsRef() {
  const rows = [
    ['Move', ['forward', 'left', 'back', 'right']], ['Sprint / hold breath', ['sprint']], ['Jump, deploy, mantle', ['jump']], ['Crouch / slide', ['crouch']],
    ['Fire / aim', ['fire', 'ads']], ['Reload', ['reload']], ['Weapons', ['slot1', 'slot2']], ['Armor plate', ['plate']], ['Frag', ['grenade']],
    ['Interact', ['interact']], ['Map', ['map']], ['Players', ['scoreboard']], ['Free look', ['freelook']],
  ];
  pauseRef.textContent = '';
  pauseRef.append(h('h2', { class: 'zf-label', text: 'Controls' }));
  const dl = h('dl', { class: 'zf-ref' });
  for (const [label, acts] of rows) dl.append(h('div', null, h('dt', { text: label }), h('dd', null, ...acts.map((a) => keycap(a)))));
  pauseRef.append(dl);
}

function togglePauseSettings(force) {
  const on = force != null ? force : !pauseSide.classList.contains('is-settings');
  pauseSide.classList.toggle('is-settings', on);
  if (on) {
    if (!pauseSettings) { pauseSettings = mountSettings(pauseSide); }
    pauseSettings.el.hidden = false;
    pauseRef.hidden = true;
    pauseSettings.refresh();
  } else {
    if (pauseSettings) pauseSettings.el.hidden = true;
    pauseRef.hidden = false;
    buildControlsRef();
  }
}

// ------------------------------------------------------------------------------------------ API
export function mount(r) {
  root = r;
  buildDeath();
  buildSpectate();
  buildResults();
  buildPause();
}

/**
 * info: {killer: {id, name, weapon, headshot, distance}|null, placement, total, kills, damage, mode}
 * Defaults come from state when fields are missing.
 */
export function showDeath(info = {}) {
  const k = info.killer || state.local.killer || {};
  const total = info.total || state.match.roster.length || MATCH.maxPlayers;
  const placement = info.placement || state.match.placement || Math.max(1, (state.match.alive || 0) + 1);
  const kills = info.kills ?? state.match.stats.kills;
  const damage = Math.round(info.damage ?? state.match.stats.damage);
  const self = !k.id || k.id === state.selfId;
  deathEl.textContent = '';
  const killerLine = h('div', { class: 'zf-death__killer' });
  if (k.weapon === 'zone' || k.weapon === 'fall') {
    killerLine.append(h('span', { class: 'zf-label', text: 'Cause' }), h('b', { text: k.weapon === 'zone' ? 'Caught in the zone' : 'Fall damage' }));
  } else if (self && k.weapon === 'frag') {
    killerLine.append(h('span', { class: 'zf-label', text: 'Cause' }), h('b', { text: 'Your own frag' }));
  } else {
    killerLine.append(h('span', { class: 'zf-label', text: 'Eliminated by' }), h('b', { text: k.name || 'Unknown' }),
      h('span', { class: 'zf-death__how' },
        h('span', { text: weaponName(k.weapon) }),
        k.headshot ? h('span', { class: 'zf-death__hs', html: `${GLYPH.head}<span>Headshot</span>` }) : null,
        k.distance ? h('span', { text: `${k.distance} m` }) : null));
  }
  const spectate = btn('Spectate', 'zf-btn--primary', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'spectate' }); });
  spectate.append(keycap('jump'));
  const leave = btn('Leave match', 'zf-btn--ghost', () => { sfx('back'); emit(EV.UI_INTENT, { type: 'leave_match' }); });
  const alive = Math.max(0, state.match.alive || 0);
  deathEl.append(
    h('div', { class: 'zf-death__scrim' }),
    h('div', { class: 'zf-death__body' },
      h('p', { class: 'zf-eyebrow' }, h('span', { text: `${ordinal(placement)} of ${total}` }), h('span', { text: `${alive} still in the fight` })),
      h('h1', { class: 'zf-death__title', text: 'Eliminated' }),
      killerLine,
      h('dl', { class: 'zf-stats zf-stats--row' },
        stat('Placement', `#${placement}`), stat('Kills', String(kills)), stat('Damage', String(damage))),
      h('div', { class: 'zf-death__actions' }, alive > 0 ? spectate : null, leave),
      h('p', { class: 'zf-death__hint' }, keycap('pause'), ' opens the menu')));
  deathEl.hidden = false;
  deathEl.classList.remove('is-in'); void deathEl.offsetWidth; deathEl.classList.add('is-in');
  open.death = true;
  sfx('back');
}

function stat(label, value, sub) {
  return h('div', { class: 'zf-stat' }, h('dt', { text: label }), h('dd', { text: value }), sub ? h('small', { text: sub }) : null);
}

export function showSpectate(targetName) {
  if (targetName == null) {
    specEl.hidden = true;
    open.spectate = false;
    specTargetId = null;
    return;
  }
  if (open.death) { deathEl.hidden = true; open.death = false; }
  setText(specName, targetName);
  specEl.hidden = false;
  open.spectate = true;
}

/** Per frame while spectating: target vitals (from the snapshot hp/armor of that entity). */
export function updateSpectate(targetId) {
  if (!open.spectate) return;
  specTargetId = targetId;
  const p = targetId ? getPlayer(targetId) : null;
  if (p) setText(specName, p.name);
  setVar(specHp, '--f', p ? Math.max(0, p.hp) / PLAYER.health : 0);
  setVar(specArmor, '--f', p ? Math.max(0, p.armor) / (PLAYER.armor.perPlate * PLAYER.armor.slots) : 0);
}

/**
 * info: {winnerId, winnerName, placement, total, mode, stats: {kills, damage, headshots, survived, longest}}
 */
export function showResults(info = {}) {
  const s = info.stats || state.match.stats;
  const placement = info.placement || state.match.placement || 1;
  const total = info.total || state.match.roster.length || MATCH.maxPlayers;
  const winnerId = info.winnerId !== undefined ? info.winnerId : state.match.winnerId;
  const won = info.won != null ? info.won : (winnerId && winnerId === state.selfId) || placement === 1;
  const winnerName = info.winnerName || (winnerId ? (getPlayer(winnerId)?.name || (state.match.roster.find((r) => r.id === winnerId) || {}).name) : null);
  const mode = info.mode || state.match.mode;
  resultsEl.textContent = '';
  resultsEl.classList.toggle('is-win', !!won);
  const again = btn('Play again', 'zf-btn--primary', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'play_again' }); }, '');
  const menuBtn = btn('Main menu', 'zf-btn--ghost', () => { sfx('back'); emit(EV.UI_INTENT, { type: 'main_menu' }); }, GLYPH.back);
  resultsEl.append(
    h('div', { class: 'zf-results__scrim' }),
    h('div', { class: 'zf-results__body' },
      h('p', { class: 'zf-eyebrow' }, h('span', { text: mode === 'practice' ? 'Practice' : mode === 'private' ? 'Private match' : 'Quick play' }), h('span', { text: 'Kessler Isle' }), h('span', { text: `${total} operators` })),
      won
        ? h('h1', { class: 'zf-results__title zf-results__title--win' }, h('span', { text: 'Victory' }))
        : h('h1', { class: 'zf-results__title' }, h('small', { text: '#' }), h('span', { text: String(placement) })),
      h('p', { class: 'zf-results__sub', text: won ? 'Last one standing' : `Placed ${ordinal(placement)} of ${total}${winnerName ? `. ${winnerName} took the win.` : ''}` }),
      h('dl', { class: 'zf-stats' },
        stat('Kills', String(s.kills || 0)),
        stat('Damage', String(Math.round(s.damage || 0))),
        stat('Headshots', String(s.headshots || 0)),
        stat('Longest kill', s.longest ? `${Math.round(s.longest)} m` : '-'),
        stat('Time survived', clock(s.survived || 0))),
      h('div', { class: 'zf-results__actions' }, again, menuBtn)));
  resultsEl.hidden = false;
  resultsEl.classList.remove('is-in'); void resultsEl.offsetWidth; resultsEl.classList.add('is-in');
  open.results = true;
  deathEl.hidden = true; open.death = false;
  showSpectate(null);
  showPause(false);
}

/**
 * Pause overlay. opts.fresh: the match started without a mouse lock yet (network start), so the overlay reads as a
 * "take control" prompt instead of a pause menu.
 */
export function showPause(isOpen, opts = {}) {
  isOpen = !!isOpen;
  const fresh = !!opts.fresh;
  if (open.pause === isOpen && pauseEl.dataset.fresh === String(fresh)) return;
  open.pause = isOpen;
  pauseEl.hidden = !isOpen;
  pauseEl.dataset.fresh = String(fresh);
  if (!isOpen) { togglePauseSettings(false); return; }
  const practice = state.match.mode === 'practice';
  pauseEl.querySelector('[data-pk]').innerHTML = '';
  pauseEl.querySelector('[data-pk]').append(h('span', { text: practice ? 'Practice' : 'Online match' }),
    h('span', { text: fresh ? 'Match started' : practice ? 'Simulation paused' : 'The match keeps running' }));
  pauseEl.querySelector('[data-pt]').textContent = fresh ? 'Ready' : practice ? 'Paused' : 'Menu';
  pauseEl.querySelector('[data-pn]').textContent = fresh
    ? 'The plane is in the air. Take control to lock the mouse and play.'
    : practice
      ? 'Resume locks the mouse again and continues the match.'
      : 'Other players can still see and shoot you. Resume to take back control.';
  pauseEl.querySelector('.zf-pause__actions .zf-btn--primary span').textContent = fresh ? 'Take control' : 'Resume';
  leaveBtn.querySelector('span').textContent = 'Leave match';
  leaveArmed = 0;
  pauseEl.classList.remove('is-in'); void pauseEl.offsetWidth; pauseEl.classList.add('is-in');
}

export function hideAll() {
  deathEl.hidden = true; open.death = false;
  showSpectate(null);
  resultsEl.hidden = true; open.results = false;
  showPause(false);
}

/** Which overlays are open (ui.js and tests). */
export function isOpen(name) { return !!open[name]; }

/** Open the pause overlay straight on its settings page (dev harness). */
export function showPauseSettings() { showPause(true); togglePauseSettings(true); }

