// BLOKSTORM - menus and the in-game display. Plain DOM, styled by styles.css.
import { ITEMS, CLASSES, CLASS_IDS, LOOK, RULES, ABILITIES, MAPS, MAP_IDS, PRICES } from './config.js';
import { itemURL, hudIcon } from './textures.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const KEY_NAMES = { Space: 'Spatie', ShiftLeft: 'Shift L', ShiftRight: 'Shift R', ControlLeft: 'Ctrl L', ControlRight: 'Ctrl R', AltLeft: 'Alt L', AltRight: 'Alt R', Tab: 'Tab', CapsLock: 'Caps', Enter: 'Enter', Backquote: '`' };
export function keyName(code) { return KEY_NAMES[code] || String(code || '?').replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, 'Pijl '); }
const LOOK_ROWS = [
  ['skin', 'Huid', 'color'], ['hairStyle', 'Kapsel', 'text'], ['hair', 'Haarkleur', 'color'], ['eyes', 'Ogen', 'color'],
  ['shirt', 'Shirt', 'color'], ['shirtStyle', 'Shirtstijl', 'text'], ['pants', 'Broek', 'color'],
  ['cape', 'Cape', 'text'], ['capeColor', 'Capekleur', 'color'], ['hat', 'Hoed', 'text'],
];

// what the mouse buttons do with the item in your hand
const HINTS = {
  block: 'Rechts: plaatsen. Kijk vooruit en loop om een brug te bouwen', melee: 'Links: slaan. Rechts vasthouden: blokkeren', tool: 'Linkermuisknop: hakken',
  bow: 'Rechts vasthouden en loslaten: schieten', ammo: 'Munitie voor de boog', throw: 'Rechtermuisknop: gooien',
  food: 'Rechts vasthouden: eten', potion: 'Rechts vasthouden: drinken', armor: 'Rechtermuisknop: aantrekken',
};

export class UI {
  /** on: callbacks the game listens to. */
  constructor(on) {
    this.on = on;
    this.screens = ['menu', 'looks', 'lobby', 'hud'];
    const click = (id, fn) => $(id).addEventListener('click', () => { sfx('click'); fn(); });
    click('btnSolo', () => on.solo());
    click('btnHost', () => on.host());
    click('btnJoin', () => on.join($('code').value.trim().toUpperCase()));
    $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') on.join($('code').value.trim().toUpperCase()); });
    click('btnLook', () => on.openLooks());
    click('btnLobbyLook', () => on.openLooks());
    click('btnLookDone', () => on.closeLooks());
    click('btnLookRandom', () => on.randomLook());
    click('btnLeave', () => on.leave());
    click('btnReady', () => on.ready());
    click('btnStart', () => on.start());
    click('botMinus', () => on.bots(-1));
    click('botPlus', () => on.bots(1));
    click('btnResume', () => on.resume());
    click('btnSettings', () => on.openSettings());
    click('btnKeysReset', () => on.resetKeys());
    click('btnInvClose', () => on.closeInv());
    click('btnInvDrop', () => on.invDrop(this.invPick));
    click('btnQuit', () => on.leave());
    $('name').addEventListener('input', () => on.name($('name').value));
    for (const [id, key] of [['setSens', 'sens'], ['setVol', 'vol'], ['setScale', 'scale'], ['setFov', 'fov']]) $(id).addEventListener('input', () => { on.setting(key, +$(id).value); this.showValues(); });

    // hotbar and hit point squares are built once
    this.slots = [];
    for (let i = 0; i < 9; i++) {
      const el = document.createElement('div'); el.className = 'slot';
      el.innerHTML = `<em>${i + 1}</em><img alt="" hidden><b></b>`;
      $('hotbar').appendChild(el); this.slots.push(el);
    }
    this.centerTimer = 0;
  }

  show(name) { for (const s of this.screens) $(s).hidden = s !== name; }
  overlay(id, on) { $(id).hidden = !on; }
  menuMsg(text) { $('menuMsg').textContent = text || ''; }
  setProfile(p, settings) {
    $('name').value = p.name;
    $('setSens').value = settings.sens; $('setVol').value = settings.vol; $('setScale').value = settings.scale; $('setFov').value = settings.fov;
    this.showValues();
  }
  showValues() {
    $('valSens').textContent = (+$('setSens').value).toFixed(2); $('valFov').textContent = $('setFov').value;
    $('valVol').textContent = `${Math.round($('setVol').value * 100)}%`;
    $('valScale').textContent = +$('setScale').value === 1 ? 'scherp' : `${$('setScale').value}x`;
  }
  /** Settings panel. In a round it is the pause screen, from the menu it only has a close button. */
  settings(on, inMatch) {
    this.overlay('pause', on);
    $('pauseTag').textContent = inMatch ? 'Pauze' : 'Menu';
    $('btnQuit').hidden = !inMatch;
    $('btnResume').textContent = inMatch ? 'Verder spelen' : 'Sluiten';
  }
  /** Key list: click a key, then press the new one. */
  buildKeys(binds, labels, change) {
    const root = $('keyList'); root.textContent = '';
    for (const action of Object.keys(labels)) {
      const row = document.createElement('div');
      const name = document.createElement('span'); name.textContent = labels[action];
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = keyName(binds[action]);
      b.addEventListener('click', () => {
        b.textContent = 'Druk toets'; b.classList.add('on');
        const grab = (e) => {
          e.preventDefault(); e.stopPropagation();
          removeEventListener('keydown', grab, true);
          if (e.code === 'Escape') { this.buildKeys(binds, labels, change); return; }
          change(action, e.code);
        };
        addEventListener('keydown', grab, true);
      });
      row.append(name, b); root.appendChild(row);
    }
  }
  /** Inventory screen: nine big slots that can be swapped. */
  inventory(inv, slot, swap) {
    if (!inv) { this.overlay('inv', false); this.invPick = null; return; }
    this.overlay('inv', true);
    if (this.invPick == null) this.invPick = slot;
    const root = $('invSlots'); root.textContent = '';
    inv.forEach((s, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'slot' + (i === this.invPick ? ' pick' : '');
      const em = document.createElement('em'); em.textContent = i + 1; b.appendChild(em);
      if (s) { const img = document.createElement('img'); img.alt = ITEMS[s.id].name; img.src = itemURL(s.id); b.appendChild(img); b.title = ITEMS[s.id].name; }
      const n = document.createElement('b'); n.textContent = s && s.n > 1 ? s.n : ''; b.appendChild(n);
      b.addEventListener('click', () => { sfx('click'); if (this.invPick === i) return; const a = this.invPick; this.invPick = i; swap(a, i); });
      root.appendChild(b);
    });
  }
  fatal(text) { $('fatalText').textContent = text; $('fatal').hidden = false; }

  // ---- looks ------------------------------------------------------------------------------------------------------
  /** shop: {owned: {key: [indexes]}, coins}. Options with a price that you do not own show the price. */
  buildLooks(look, change, shop = { owned: {}, coins: 0 }) {
    $('lookCoins').textContent = `Je hebt ${shop.coins} munten. Verdien ze door te spelen, kills te maken en te winnen.`;
    const root = $('lookRows');
    root.textContent = '';
    for (const [key, label, type] of LOOK_ROWS) {
      const row = document.createElement('div'); row.className = 'rowL';
      const name = document.createElement('span'); name.textContent = label;
      const opts = document.createElement('div'); opts.className = 'swatches';
      LOOK[key].forEach((v, i) => {
        const b = document.createElement('button'); b.type = 'button';
        if (type === 'color') { b.className = 'sw'; b.style.background = v; b.setAttribute('aria-label', `${label} ${i + 1}`); }
        else {
          b.className = 'chip'; b.textContent = v;
          const price = PRICES[key] ? PRICES[key][i] : 0;
          if (price && !(shop.owned[key] || []).includes(i)) { b.classList.add('locked'); const s = document.createElement('small'); s.textContent = price; b.appendChild(s); b.title = `Kost ${price} munten`; }
        }
        if (look[key] === i) b.classList.add('on');
        b.addEventListener('click', () => { sfx('click'); change(key, i); });
        opts.appendChild(b);
      });
      row.append(name, opts); root.appendChild(row);
    }
  }

  // ---- lobby ------------------------------------------------------------------------------------------------------
  setLobby({ code, players, me, isHost, online, map }) {
    const ml = $('mapList'); ml.textContent = '';
    for (const id of MAP_IDS) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (id === map ? ' on' : ''); b.textContent = MAPS[id].name; b.disabled = !isHost;
      b.addEventListener('click', () => { sfx('click'); this.on.map(id); });
      ml.appendChild(b);
    }
    $('mapLine').textContent = (MAPS[map] || MAPS.klassiek).line + (isHost ? '' : ' De host kiest de map.');
    $('lobbyCode').textContent = online ? code : 'OEFENEN';
    $('lobbyHint').textContent = online ? (isHost ? 'Deel deze code met je vrienden. Jij start de ronde.' : 'Wachten tot de host start.') : 'Alleen jij en de bots. Kies een klasse en start.';
    $('lobbyCount').textContent = `${players.length}/${RULES.maxPlayers}`;
    const list = $('lobbyPlayers'); list.textContent = '';
    for (const p of players) {
      const li = document.createElement('li'); if (p.id === me) li.className = 'me';
      const b = document.createElement('b'); b.textContent = p.name;
      const s = document.createElement('span'); s.textContent = CLASSES[p.cls].name;
      const i = document.createElement('i'); i.textContent = p.bot ? 'BOT' : p.ready ? 'KLAAR' : 'WACHT'; if (p.ready) i.className = 'ok';
      li.append(b, s, i); list.appendChild(li);
    }
    const mine = players.find((p) => p.id === me);
    $('botRow').hidden = !isHost; $('btnStart').hidden = !isHost; $('btnReady').hidden = isHost;
    $('botCount').textContent = players.filter((p) => p.bot).length;
    $('btnReady').classList.toggle('on', !!(mine && mine.ready));
    $('btnReady').textContent = mine && mine.ready ? 'Klaar gemeld' : 'Klaar';
    const cl = $('classList');
    if (!cl.children.length) {
      for (const id of CLASS_IDS) {
        const c = CLASSES[id];
        const b = document.createElement('button'); b.type = 'button'; b.className = 'cls'; b.dataset.id = id;
        b.innerHTML = `<img alt="" src="${itemURL(c.kit[0][0])}"><b>${c.name}</b><span>${c.line}</span>`;
        b.addEventListener('click', () => { sfx('click'); this.on.cls(id); });
        cl.appendChild(b);
      }
    }
    for (const b of cl.children) b.classList.toggle('on', !!mine && b.dataset.id === mine.cls);
  }

  // ---- HUD --------------------------------------------------------------------------------------------------------
  setInv(inv, slot, pop = -1) {
    this.slots.forEach((el, i) => {
      const s = inv[i], img = el.children[1], n = el.children[2];
      el.classList.toggle('on', i === slot);
      img.hidden = !s;
      if (s) { const url = itemURL(s.id); if (img.dataset.id !== s.id) { img.src = url; img.dataset.id = s.id; } }
      n.textContent = s && s.n > 1 ? s.n : '';
      if (i === pop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    });
    const held = inv[slot];
    $('itemName').textContent = held ? ITEMS[held.id].name : '';
    $('itemHint').textContent = held ? HINTS[ITEMS[held.id].kind] || '' : '';
  }
  /** A row of ten-ish icons. value and max in half-icons (2 per icon). */
  icons(id, kind, value, max) {
    const root = $(id), n = Math.ceil(max / 2);
    while (root.children.length < n) root.appendChild(document.createElement('i'));
    while (root.children.length > n) root.lastChild.remove();
    for (let i = 0; i < n; i++) {
      const state = value >= i * 2 + 2 ? 2 : value >= i * 2 + 1 ? 1 : 0, el = root.children[i];
      if (el.dataset.s !== String(state)) { el.dataset.s = state; el.style.backgroundImage = `url(${hudIcon(kind, state)})`; }
    }
  }
  setHp(hp, max) { this.icons('hp', 'heart', Math.ceil(hp - 0.01), max); $('hp').classList.toggle('low', hp > 0 && hp <= 6); }
  /** Armour as chest plates out of ten: 15% = 3, 30% = 6, 45% = 9. */
  setArmor(a) { this.icons('armor', 'armor', Math.round(a * 40), a ? 20 : 0); }
  /** f from 0 to 1; tired = ran empty and cannot sprint yet. */
  setStamina(f, tired) { this.icons('stam', 'bolt', Math.round(f * 20), 20); $('stam').classList.toggle('empty', tired); }
  setEffects(list) { const key = list.join('|'); if (key === this.fxKey) return; this.fxKey = key; $('effects').innerHTML = list.map((t) => `<span>${t}</span>`).join(''); }
  setTop(alive, kills, zoneLabel, zoneText, closing) {
    $('hudAlive').textContent = alive; $('hudKills').textContent = kills;
    $('hudZoneLabel').textContent = zoneLabel; $('hudZone').textContent = zoneText;
    $('zoneStat').classList.toggle('closing', closing);
  }
  /** Small map: the circle, the middle island, the spawn islands and you. */
  radar(me, yaw, radius, closing, spawns, air = [], size = 62) {
    const c = $('radar'), g = c.getContext('2d'), k = 50 / size, m = 56;
    g.clearRect(0, 0, 112, 112);
    g.fillStyle = '#3d5552';
    for (const s of spawns) g.fillRect(Math.round(m + (s.x - 56) * k) - 2, Math.round(m + (s.z - 56) * k) - 2, 4, 4);
    g.fillStyle = '#58a53f'; g.beginPath(); g.arc(m, m, Math.max(3, 3 * k), 0, 6.3); g.fill();
    g.fillStyle = '#20e7b7'; g.fillRect(m - 1, m - 1, 3, 3);
    g.fillStyle = '#e8c63a'; for (const a of air) g.fillRect(Math.round(m + (a.x - 56) * k) - 2, Math.round(m + (a.z - 56) * k) - 2, 5, 5);
    g.strokeStyle = closing ? '#e5484d' : '#e9e7e1'; g.lineWidth = 1; g.beginPath(); g.arc(m, m, Math.max(1, radius * k), 0, 6.3); g.stroke();
    if (!me) return;
    const x = m + (me.x - 56) * k, z = m + (me.z - 56) * k;
    g.strokeStyle = '#e8c63a'; g.beginPath(); g.moveTo(x, z); g.lineTo(x - Math.sin(yaw) * 9, z - Math.cos(yaw) * 9); g.stroke();
    g.fillStyle = '#e8c63a'; g.fillRect(Math.round(x) - 2, Math.round(z) - 2, 4, 4);
  }
  setDrip(f) { $('dripFill').style.width = `calc(${(f * 100).toFixed(1)}% - 4px)`; }
  warn(on) { $('warn').hidden = !on; }
  /** Ability box: left = seconds until it is ready again. */
  ability(name, key, left, cd) {
    $('abName').textContent = name; $('abKey').textContent = key;
    $('abTime').textContent = left > 0 ? Math.ceil(left) : '';
    $('ability').classList.toggle('wait', left > 0);
    $('abFill').style.width = `${Math.round((1 - Math.max(0, left) / cd) * 100)}%`;
  }
  progress(level, coins, frac) { $('pLevel').textContent = `Level ${level}`; $('pCoins').textContent = `${coins} munten`; $('pBar').style.width = `${Math.round(frac * 100)}%`; }
  /** Attack bar under the crosshair: fills up after a swing. */
  swing(f) { const s = $('swing'); s.hidden = f >= 1; if (f < 1) s.firstElementChild.style.width = `${Math.round(f * 100)}%`; }
  stats(text) { $('stats').textContent = text; }
  charge(f) { $('charge').hidden = f == null; if (f != null) $('charge').firstElementChild.style.width = `${Math.round(f * 100)}%`; }
  tip(text) {
    $('tip').hidden = !text; $('tipText').textContent = text || '';
    clearTimeout(this.tipTimer);
    if (text) this.tipTimer = setTimeout(() => { $('tip').hidden = true; }, 9000);
  }
  /** Player list while Tab is held. list: [{name, kills, alive, me}] or null to hide. */
  board(list) {
    $('board').hidden = !list;
    if (!list) return;
    const ol = $('boardList'); ol.textContent = '';
    for (const p of list) {
      const li = document.createElement('li'); if (!p.alive) li.className = 'out';
      const n = document.createElement('b'); n.textContent = p.name + (p.me ? ' (jij)' : '');
      const k = document.createElement('span'); k.textContent = `${p.alive ? '' : 'uit · '}${p.kills || 0} kills`;
      li.append(n, k); ol.appendChild(li);
    }
  }
  spec(name) { $('spec').hidden = name == null; if (name != null) $('specName').textContent = name; }
  hitMark() { const h = $('hitmark'); h.hidden = false; clearTimeout(this.hitTimer); this.hitTimer = setTimeout(() => { h.hidden = true; }, 140); }
  lockHint(on) { $('lockHint').hidden = !on; }
  hurt() { const h = $('hud'); h.classList.add('hurt'); clearTimeout(this.hurtTimer); this.hurtTimer = setTimeout(() => h.classList.remove('hurt'), 160); }
  center(big, small = '', ms = 1600) {
    const c = $('center'); c.textContent = big;
    if (small) { const s = document.createElement('small'); s.textContent = small; c.appendChild(s); }
    clearTimeout(this.centerTimer);
    if (ms) this.centerTimer = setTimeout(() => { c.textContent = ''; }, ms);
  }
  /** parts: strings are plain text, [text] arrays are shown bold. */
  feed(parts) {
    const li = document.createElement('li');
    for (const p of parts) { if (Array.isArray(p)) { const b = document.createElement('b'); b.textContent = p[0]; li.appendChild(b); } else li.append(p); }
    const f = $('feed'); f.appendChild(li);
    while (f.children.length > 5) f.firstChild.remove();
    setTimeout(() => li.remove(), 6000);
  }
  clearHud() { $('swing').hidden = true; this.tip(''); this.board(null); $('feed').textContent = ''; $('center').textContent = ''; this.warn(false); this.charge(null); this.spec(null); }

  end(title, tag, rank, me, pay = '') {
    $('endPay').textContent = pay;
    $('endTitle').textContent = title; $('endTag').textContent = tag;
    const ol = $('endRank'); ol.textContent = '';
    for (const r of rank.slice(0, 8)) {
      const li = document.createElement('li');
      const n = document.createElement('b'); n.textContent = r.name + (r.id === me ? ' (jij)' : '');
      const k = document.createElement('span'); k.textContent = `${r.kills} kills`;
      li.append(n, k); ol.appendChild(li);
    }
    this.overlay('end', true);
  }
}
