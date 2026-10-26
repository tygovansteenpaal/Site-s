// ZONEFALL - loading screen, main menu, private match dialog, credits. OWNER: UI. Contract: ARCHITECTURE.md 9.
// Menu over the live 3D island flyover: wordmark, callsign field (settings 'name'), QUICK PLAY, PRIVATE MATCH
// (create / join with code), PRACTICE VS BOTS, SETTINGS, CREDITS (text from assets/LICENSES/CREDITS.md section
// "In-game credits text", verbatim). First click anywhere calls audio.unlock(). Touch-only devices see a notice that
// a keyboard and mouse are required, with practice still available.
// The loading screen draws Kessler Isle from core/mapdata (coastline, roads, sites) as a survey plot that completes with
// the real LOAD_PROGRESS value, under a large percentage counter.
import { emit, on, EV } from '../core/bus.js';
import * as settings from '../core/settings.js';
import { state } from '../core/state.js';
import { MAP, POIS, LANDMARKS, ROADS, FORESTS } from '../core/mapdata.js';
import { VERSION, NET, MATCH, assetUrl } from '../config.js';
import * as lobbyNet from '../net/lobby.js';
import { h, sfx, GLYPH, esc, keycap } from './dom.js';
import { mountSettings } from './settings.js';
import { mountShop } from './shop.js';
import * as profile from '../core/profile.js';

export const CREDITS_TEXT = 'Soldiers: Microsoft Rocketbox Avatar Library (MIT). Animations: Quaternius Universal Animation Library (CC0) and Rocketbox. Weapons: Stein Games, 3dmodelscc0, Poly Haven (CC0). Props, textures and skies: Poly Haven (CC0). Gunshot recordings: Vincent Sevedge, CC BY 3.0 (opengameart.org/content/gunshot-sounds), sliced and edited. Reload sounds: SpringySpringo (CC0). Impact and footstep sounds: Kenney (CC0). Character outfits: Sketchfab models by mochi, Neut2000, HarrisonHag1, Jesús Dorado, GatoBugadoBR, TheBuffalo, Desireless, Fortnite Models (The Realm Geno YT), Elite Big Speakerman, Guilherme Navarro, CC BY 4.0, converted for the game.';

const TIPS = [
  'Armor plates absorb bullet damage before health. Press [plate] to insert one; it takes just over a second.',
  'Health regenerates after five seconds without taking damage.',
  'The zone deals more damage every phase and ignores armor. Watch the timer under the compass.',
  'Hold [sprint] while scoped with the M700 to steady your aim for a few seconds.',
  'Recoil is a fixed pattern for every weapon. Pull down against it and it becomes predictable.',
  'Supply crates hold three items one tier above the area they sit in. Fort Kessler has the best loot on the island.',
  'Gunfire within range shows up as a red ping on your minimap and compass. So does yours.',
  'Press [map] for the full map with both zone circles and the plane route.',
  'Doors open once the plane reaches the island. Press [jump] to drop, and again to open the parachute.',
  'Slide by pressing [crouch] while sprinting. It is the fastest way across open ground.',
];

const ITEMS = [
  { id: 'quickplay', label: 'Quick play', sub: `Public lobby for up to ${MATCH.maxHumans} players. Bots fill every empty slot.`, primary: true },
  { id: 'private', label: 'Private match', sub: 'Create a lobby and share the code, or join one.' },
  { id: 'practice', label: 'Practice vs bots', sub: `Offline match against ${MATCH.maxPlayers - 1} bots. Pauses when you open the menu.` },
  { id: 'shop', label: 'Locker & shop', sub: 'Outfits for you on the island. Buy with coins earned in matches.' },
  { id: 'settings', label: 'Settings', sub: 'Sensitivity, field of view, graphics, audio, controls.' },
  { id: 'credits', label: 'Credits', sub: 'Assets, sounds and licences.' },
];

let root = null, loadingEl = null, menuEl = null;
let countEl = null, labelEl = null, barEl = null, tipEl = null, surveyEl = null, stageEls = [];
let panelEl = null, panelBody = null, panelTitle = null, navEl = null;
let settingsPanel = null, privateEl = null, creditsEl = null, shopPanel = null;
let view = 'home';
let tipTimer = 0, tipIdx = 0;
let loadingShown = false, loadP = 0;

// ------------------------------------------------------------------------------------------ survey plot (loading)
function coastPath() {
  const pts = [];
  for (let i = 0; i <= 180; i++) {
    const t = (i / 180) * Math.PI * 2;
    const r = MAP.coastBase + 28 * Math.sin(3 * t + 0.9) + 14 * Math.sin(7 * t + 2.3);
    pts.push(`${(r * Math.cos(t)).toFixed(1)},${(r * Math.sin(t)).toFixed(1)}`);
  }
  return 'M' + pts.join('L') + 'Z';
}

function surveySvg() {
  const grid = [];
  for (let v = -500; v <= 500; v += 100) {
    grid.push(`<line x1="${v}" y1="-560" x2="${v}" y2="560"/><line x1="-560" y1="${v}" x2="560" y2="${v}"/>`);
  }
  const roads = ROADS.map((r) => `<polyline class="zf-survey__road zf-survey__road--${r.type}" pathLength="1" points="${r.pts.map((p) => p.join(',')).join(' ')}"/>`).join('');
  const forests = FORESTS.map(([x, z, r]) => `<circle class="zf-survey__forest" cx="${x}" cy="${z}" r="${r}"/>`).join('');
  const sites = [...POIS, ...LANDMARKS].map((s, i) => {
    const major = POIS.includes(s);
    const anchor = s.x > 250 ? 'end' : 'start';
    const dx = anchor === 'end' ? -16 : 16;
    return `<g class="zf-survey__site${major ? ' is-major' : ''}" data-stage="${i}" transform="translate(${s.x} ${s.z})">` +
      `<circle r="${major ? 7 : 4.5}"/><circle class="zf-survey__ring" r="${Math.min(s.r, 60)}"/>` +
      `<text x="${dx}" y="5" text-anchor="${anchor}">${esc(s.name)}</text></g>`;
  }).join('');
  return `<svg class="zf-survey" viewBox="-600 -600 1200 1200" aria-hidden="true">
    <g class="zf-survey__grid">${grid.join('')}</g>
    <path class="zf-survey__coast-fill" d="${coastPath()}"/>
    <g class="zf-survey__forests">${forests}</g>
    <path class="zf-survey__coast" pathLength="1" d="${coastPath()}"/>
    <g class="zf-survey__roads">${roads}</g>
    <g class="zf-survey__sites">${sites}</g>
    <g class="zf-survey__north" transform="translate(500 -500)"><path d="M0 -26 L9 6 L0 0 L-9 6Z"/><text y="28" text-anchor="middle">N</text></g>
  </svg>`;
}

function buildLoading() {
  loadingEl = h('section', { class: 'zf-loading', 'aria-label': 'Loading', role: 'status', 'aria-live': 'polite' });
  loadingEl.innerHTML = `
    <div class="zf-loading__top">
      <div class="zf-brand">${GLYPH.mark}<span class="zf-brand__name">ZONEFALL</span></div>
      <div class="zf-loading__meta"><span>${esc(MAP.name)}</span><span>BUILD ${esc(VERSION)}</span></div>
    </div>
    <div class="zf-loading__plot">${surveySvg()}</div>
    <div class="zf-loading__bottom">
      <div class="zf-loading__readout">
        <div class="zf-loading__label"><span class="zf-loading__dot"></span><span data-label>Starting</span></div>
        <div class="zf-loading__count"><span data-count>000</span><i>%</i></div>
      </div>
      <p class="zf-loading__tip" data-tip></p>
    </div>
    <div class="zf-loading__bar"><i data-bar></i></div>`;
  countEl = loadingEl.querySelector('[data-count]');
  labelEl = loadingEl.querySelector('[data-label]');
  barEl = loadingEl.querySelector('[data-bar]');
  tipEl = loadingEl.querySelector('[data-tip]');
  surveyEl = loadingEl.querySelector('.zf-survey');
  stageEls = [...loadingEl.querySelectorAll('.zf-survey__site')];
  root.append(loadingEl);
}

function tipText(i) {
  const tpl = TIPS[i % TIPS.length];
  const el = h('span');
  const parts = tpl.split(/\[(\w+)\]/);
  parts.forEach((p, k) => { if (k % 2) el.append(keycap(p)); else if (p) el.append(p); });
  return el;
}

function rotateTip() {
  tipIdx = (tipIdx + 1) % TIPS.length;
  tipEl.textContent = '';
  tipEl.append(h('b', { text: 'Field note' }), tipText(tipIdx));
  tipEl.classList.remove('is-in');
  void tipEl.offsetWidth;
  tipEl.classList.add('is-in');
}

// ------------------------------------------------------------------------------------------ menu
function buildMenu() {
  menuEl = h('section', { class: 'zf-menu', 'aria-label': 'Main menu', hidden: true });
  const scrim = h('div', { class: 'zf-menu__scrim' });

  const soundBtn = h('button', { type: 'button', class: 'zf-iconbtn', 'aria-label': 'Toggle sound' });
  const paintSound = () => {
    const m = settings.get('muted');
    soundBtn.innerHTML = (m ? GLYPH.muted : GLYPH.sound) + `<span>${m ? 'Sound off' : 'Sound on'}</span>`;
    soundBtn.setAttribute('aria-pressed', String(!m));
  };
  soundBtn.addEventListener('click', () => { settings.set('muted', !settings.get('muted')); paintSound(); });
  on(EV.SETTINGS_CHANGED, ({ key }) => { if (key === 'muted') paintSound(); });
  paintSound();

  const coinBtn = h('button', { type: 'button', class: 'zf-iconbtn zf-coinbtn', 'aria-label': 'Open the shop' });
  const paintCoins = () => {
    coinBtn.textContent = '';
    coinBtn.append(h('span', { class: 'zf-coin', 'aria-hidden': 'true' }), h('span', { text: profile.coins().toLocaleString('en-US') }));
  };
  coinBtn.addEventListener('click', () => { sfx('tick'); setView('shop'); });
  on(profile.PEV.PROFILE_CHANGED, paintCoins);
  paintCoins();

  const top = h('header', { class: 'zf-menu__top' },
    h('div', { class: 'zf-brand', html: `${GLYPH.mark}<span class="zf-brand__name">ZONEFALL</span>` }),
    h('div', { class: 'zf-menu__crumbs', html: `<span>${esc(MAP.name)}</span><span>Solo battle royale</span><span>${MATCH.maxPlayers} operators</span>` }),
    h('div', { class: 'zf-menu__tools' }, coinBtn, soundBtn));

  // callsign
  const nameIn = h('input', { type: 'text', class: 'zf-callsign__input', maxlength: 16, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Callsign' });
  nameIn.value = settings.get('name');
  const commitName = () => { nameIn.value = settings.set('name', nameIn.value) || settings.get('name'); };
  nameIn.addEventListener('change', commitName);
  nameIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { commitName(); nameIn.blur(); } });
  on(EV.SETTINGS_CHANGED, ({ key }) => { if (key === 'name' && document.activeElement !== nameIn) nameIn.value = settings.get('name'); });
  const callsign = h('label', { class: 'zf-callsign' }, h('span', { class: 'zf-callsign__label', text: 'Callsign' }), nameIn,
    h('span', { class: 'zf-callsign__hint', text: 'Shown to other players' }));

  navEl = h('nav', { class: 'zf-menu__nav', 'aria-label': 'Game modes' });
  ITEMS.forEach((it, i) => {
    const b = h('button', { type: 'button', class: 'zf-navitem' + (it.primary ? ' zf-navitem--primary' : ''), data: { id: it.id } },
      h('span', { class: 'zf-navitem__idx', text: String(i + 1).padStart(2, '0') }),
      h('span', { class: 'zf-navitem__text' }, h('span', { class: 'zf-navitem__label', text: it.label }), h('span', { class: 'zf-navitem__sub', text: it.sub })),
      h('span', { class: 'zf-navitem__go', html: GLYPH.chevron }));
    b.addEventListener('click', () => activate(it.id));
    navEl.append(b);
  });

  const touch = h('p', { class: 'zf-menu__touch', hidden: true, text: 'ZONEFALL needs a keyboard and mouse. On this device you can still watch the island or start a practice match.' });
  try { touch.hidden = !(matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches); } catch (e) { touch.hidden = true; }

  const main = h('div', { class: 'zf-menu__main' },
    h('p', { class: 'zf-eyebrow', html: `<span>Kessler Isle</span><span>Last one standing</span>` }),
    h('h1', { class: 'zf-wordmark', 'aria-label': 'ZONEFALL' }, h('span', { text: 'ZONE' }), h('span', { text: 'FALL' })),
    h('p', { class: 'zf-menu__lede', text: `Drop onto a 1.2 km island with ${MATCH.maxPlayers - 1} others. Loot what you land on, plate up, and stay inside the zone as it closes.` }),
    callsign, navEl, touch);

  // side panel (private / shop / settings / credits)
  panelTitle = h('h2', { class: 'zf-panel__title' });
  const backBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost zf-btn--sm zf-panel__back', html: `${GLYPH.back}<span>Back</span>` });
  backBtn.addEventListener('click', () => { sfx('back'); setView('home'); });
  panelBody = h('div', { class: 'zf-panel__body' });
  panelEl = h('aside', { class: 'zf-panel', hidden: true }, h('header', { class: 'zf-panel__head' }, panelTitle, backBtn), panelBody);

  const region = regionName();
  const footer = h('footer', { class: 'zf-menu__foot' },
    h('span', { html: `${GLYPH.signal}<b>Region</b> ${esc(region)}` }),
    h('span', { 'data-tier': '', html: '' }),
    h('span', { html: `<b>Build</b> ${esc(VERSION)}` }));
  const paintTier = () => {
    const pref = settings.get('quality');
    footer.querySelector('[data-tier]').innerHTML = `<b>Graphics</b> ${esc(String(state.quality || 'medium').toUpperCase())}${pref === 'auto' ? ' (auto)' : ''}`;
  };
  on(EV.QUALITY_CHANGED, paintTier);
  on(EV.SETTINGS_CHANGED, ({ key }) => { if (key === 'quality') paintTier(); });
  paintTier();

  menuEl.append(scrim, top, main, panelEl, footer);
  root.append(menuEl);

  menuEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view !== 'home') { e.preventDefault(); sfx('back'); setView('home'); }
  });
}

function regionName() {
  const names = { eu: 'Europe', na: 'North America', sa: 'South America', as: 'Asia', oc: 'Oceania', af: 'Africa' };
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const r = typeof lobbyNet.regionFromTimeZone === 'function' ? lobbyNet.regionFromTimeZone(tz, -new Date().getTimezoneOffset()) : null;
    return names[r] || 'Automatic';
  } catch (e) { return 'Automatic'; }
}

function activate(id) {
  if (id === 'quickplay') { sfx('confirm'); emit(EV.UI_INTENT, { type: 'quickplay' }); }
  else if (id === 'practice') { sfx('confirm'); emit(EV.UI_INTENT, { type: 'practice' }); }
  else setView(id);
}

function setView(v) {
  view = v;
  const open = v !== 'home';
  panelEl.hidden = !open;
  menuEl.classList.toggle('has-panel', open);
  for (const b of navEl.children) b.classList.toggle('is-current', b.dataset.id === v);
  if (!open) {
    if (menuEl.contains(document.activeElement) && document.activeElement !== document.body) navEl.querySelector('[data-id="quickplay"]')?.focus({ preventScroll: true });
    return;
  }
  panelBody.textContent = '';
  if (v === 'private') { panelTitle.textContent = 'Private match'; panelBody.append(buildPrivate()); }
  else if (v === 'settings') {
    panelTitle.textContent = 'Settings';
    if (!settingsPanel) settingsPanel = mountSettings(h('div'));
    panelBody.append(settingsPanel.el);
    settingsPanel.refresh();
  } else if (v === 'credits') { panelTitle.textContent = 'Credits'; panelBody.append(buildCredits()); }
  else if (v === 'shop') {
    panelTitle.textContent = 'Locker & shop';
    if (!shopPanel) shopPanel = mountShop();
    panelBody.append(shopPanel.el);
    shopPanel.refresh();
  }
  panelEl.classList.toggle('zf-panel--wide', v === 'shop');
  panelEl.classList.remove('is-in');
  void panelEl.offsetWidth;
  panelEl.classList.add('is-in');
}

function normalizeCode(s) {
  const allowed = NET.codeAlphabet;
  return String(s || '').toUpperCase().split('').filter((c) => allowed.includes(c)).join('').slice(0, NET.codeLength);
}

function buildPrivate() {
  if (privateEl) { privateEl.querySelector('input').value = ''; privateEl.querySelector('[data-join]').disabled = true; return privateEl; }
  const create = h('button', { type: 'button', class: 'zf-btn zf-btn--primary', html: `<span>Create lobby</span>${GLYPH.chevron}` });
  create.addEventListener('click', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'create_private' }); });
  const codeIn = h('input', { type: 'text', class: 'zf-code__input', maxlength: NET.codeLength, spellcheck: 'false', autocomplete: 'off', inputmode: 'text', 'aria-label': 'Lobby code' });
  const cells = h('div', { class: 'zf-code__cells', 'aria-hidden': 'true' });
  for (let i = 0; i < NET.codeLength; i++) cells.append(h('span'));
  const join = h('button', { type: 'button', class: 'zf-btn zf-btn--solid', disabled: true, data: { join: '' }, html: `<span>Join</span>${GLYPH.chevron}` });
  const paint = () => {
    const v = codeIn.value;
    [...cells.children].forEach((c, i) => { c.textContent = v[i] || ''; c.classList.toggle('is-caret', i === Math.min(v.length, NET.codeLength - 1) && document.activeElement === codeIn); });
    join.disabled = v.length !== NET.codeLength;
  };
  codeIn.addEventListener('input', () => { const n = normalizeCode(codeIn.value); if (n !== codeIn.value) codeIn.value = n; paint(); sfx('tick'); });
  codeIn.addEventListener('focus', paint);
  codeIn.addEventListener('blur', paint);
  codeIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !join.disabled) join.click(); });
  join.addEventListener('click', () => { if (codeIn.value.length !== NET.codeLength) { sfx('error'); return; } sfx('confirm'); emit(EV.UI_INTENT, { type: 'join_private', code: codeIn.value }); });
  const code = h('label', { class: 'zf-code' }, codeIn, cells);
  privateEl = h('div', { class: 'zf-private' },
    h('section', { class: 'zf-private__col' },
      h('h3', { class: 'zf-label', text: 'Host' }),
      h('p', { class: 'zf-private__lede', text: `Open a lobby with a ${NET.codeLength}-character code. Share the code or the invite link; up to ${MATCH.maxHumans} players can join and bots fill the remaining slots.` }),
      create),
    h('div', { class: 'zf-private__or', 'aria-hidden': 'true', text: 'or' }),
    h('section', { class: 'zf-private__col' },
      h('h3', { class: 'zf-label', text: 'Join with code' }),
      code, join,
      h('p', { class: 'zf-private__hint', text: 'Codes use letters and digits without I, L, O, 0 or 1.' })));
  paint();
  return privateEl;
}

function buildCredits() {
  if (creditsEl) return creditsEl;
  const rows = [
    ['Soldiers', 'Microsoft Rocketbox Avatar Library', 'MIT'],
    ['Animations', 'Quaternius Universal Animation Library 1 and 2, retargeted; Rocketbox', 'CC0 / MIT'],
    ['Weapons', 'Stein Games Classic Weapons Pack, 3dmodelscc0 Guns and Explosives Pack, Poly Haven', 'CC0'],
    ['Props, textures, skies', 'Poly Haven and its artists', 'CC0'],
    ['Outfits', 'Sketchfab: mochi, Neut2000, HarrisonHag1, Jesús Dorado, GatoBugadoBR, TheBuffalo, Desireless, Fortnite Models (The Realm Geno YT), Elite Big Speakerman, Guilherme Navarro', 'CC BY 4.0'],
    ['Gunshot recordings', 'Vincent Sevedge, opengameart.org/content/gunshot-sounds, sliced and edited', 'CC BY 3.0'],
    ['Reload sounds', 'SpringySpringo', 'CC0'],
    ['Impact and footstep sounds', 'Kenney, kenney.nl', 'CC0'],
    ['Synthesized sounds', 'Made for ZONEFALL', 'CC0'],
    ['Engine', 'three.js, three-mesh-bvh, ez-tree (MIT), postprocessing (Zlib)', 'Open source'],
    ['Networking', 'Trystero over public Nostr relays, WebRTC', 'MIT'],
    ['Type', 'Barlow, Barlow Condensed, JetBrains Mono', 'OFL'],
  ];
  const table = h('dl', { class: 'zf-credits__list' });
  for (const [k, v, lic] of rows) table.append(h('div', { class: 'zf-credits__row' }, h('dt', { text: k }), h('dd', { text: v }), h('dd', { class: 'zf-credits__lic', text: lic })));
  const links = h('p', { class: 'zf-credits__links' }, 'Full licence texts: ',
    ...[['CREDITS.md', 'Asset credits'], ['Microsoft-Rocketbox-MIT-LICENSE.md', 'Rocketbox MIT'], ['Quaternius-UAL-License.txt', 'Quaternius CC0'], ['SteinGames-ClassicWeaponsPack-license.txt', 'Stein Games CC0']]
      .flatMap(([f, t], i) => [i ? ' / ' : '', h('a', { href: assetUrl('LICENSES/' + f), target: '_blank', rel: 'noopener', text: t })]));
  creditsEl = h('div', { class: 'zf-credits' },
    h('blockquote', { class: 'zf-credits__quote', text: CREDITS_TEXT }),
    table, links,
    h('p', { class: 'zf-credits__fine', text: 'All weapons are generic models without trademarks. The outfit characters belong to their respective rights holders.' }));
  return creditsEl;
}

// ------------------------------------------------------------------------------------------ API
export function mount(r) {
  root = r;
  buildLoading();
  buildMenu();
}

export function show() {
  menuEl.hidden = false;
  menuEl.classList.remove('is-in');
  void menuEl.offsetWidth;
  menuEl.classList.add('is-in');
  setView('home');
}

export function hide() {
  menuEl.hidden = true;
  if (view !== 'home') setView('home');
}

export function showLoading(p, label) {
  if (!loadingShown) {
    loadingShown = true;
    loadingEl.hidden = false;
    loadingEl.classList.remove('is-out');
    tipIdx = Math.floor(Math.random() * TIPS.length) - 1;
    rotateTip();
    clearInterval(tipTimer);
    tipTimer = setInterval(rotateTip, 5200);
  }
  if (typeof p === 'number' && Number.isFinite(p)) loadP = Math.max(0, Math.min(1, p));
  const pct = Math.floor(loadP * 100);
  countEl.textContent = String(pct).padStart(3, '0');
  if (label) labelEl.textContent = label;
  barEl.style.transform = `scaleX(${loadP.toFixed(4)})`;
  surveyEl.style.setProperty('--p', loadP.toFixed(4));
  const n = stageEls.length;
  stageEls.forEach((el, i) => el.classList.toggle('is-on', loadP >= 0.15 + (i / n) * 0.8));
}

export function hideLoading() {
  if (!loadingShown) return;
  loadingShown = false;
  clearInterval(tipTimer);
  loadingEl.classList.add('is-out');
  setTimeout(() => { if (!loadingShown) loadingEl.hidden = true; }, 700);
}

export function showCredits() {
  if (menuEl.hidden) show();
  setView('credits');
}

/** Open a menu panel by id ('private' | 'shop' | 'settings' | 'credits' | 'home'), used by the dev harness. */
export function openPanel(id) { if (menuEl.hidden) show(); setView(id); }

/** Escape hatch for tests: current view id. */
export function currentView() { return view; }

