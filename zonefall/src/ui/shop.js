// ZONEFALL - shop and locker panels for the main menu, plus the coin balance chip. OWNER: UI (addition).
// Shop: every skin as a card (render, rarity, name, blurb, price). Buying asks for a second click to confirm.
// Locker: the equipped skin large, every owned skin as a tile to equip, locked ones dimmed with a link to the shop.
// All state comes from game/locker; panels repaint on its CHANGED event.
import { on, emit, EV } from '../core/bus.js';
import { SKINS, SKIN_RARITY, assetUrl } from '../config.js';
import * as locker from '../game/locker.js';
import { h, sfx, esc } from './dom.js';

export const COIN_SVG = '<svg class="zf-coin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z" fill="currentColor" opacity=".22"/><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 9.2h6L9 14.8h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const order = () => Object.values(SKINS).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));

function card(s, big = false) {
  const r = SKIN_RARITY[s.rarity] || SKIN_RARITY.common;
  const art = h('div', { class: 'zf-skin__art' + (big ? ' zf-skin__art--big' : '') });
  art.style.setProperty('--rar', r.color);
  if (s.card) {
    const img = h('img', { src: assetUrl(s.card), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', () => img.remove(), { once: true });
    art.append(img);
  }
  art.append(h('span', { class: 'zf-skin__rarity', text: r.label }));
  return art;
}

/** Coin balance chip (menu top bar); keeps itself current. */
export function coinChip() {
  const el = h('div', { class: 'zf-coins', title: 'Coins: earned every match, spent in the shop' });
  const paint = () => { el.innerHTML = `${COIN_SVG}<b>${fmt(locker.coins())}</b><span>Coins</span>`; };
  on(locker.LEV.CHANGED, paint);
  paint();
  return el;
}

// ------------------------------------------------------------------------------------------ shop
export function buildShop(openLocker) {
  const el = h('div', { class: 'zf-shop' });
  let confirming = null;
  const paint = () => {
    el.textContent = '';
    const snap = locker.snapshot();
    el.append(h('div', { class: 'zf-shop__bar' },
      h('p', { class: 'zf-shop__lede', text: 'Earn coins every match: for playing, for every kill, and more the higher you place. Skins change how others see you, never how you play.' }),
      h('div', { class: 'zf-shop__balance', html: `${COIN_SVG}<b>${fmt(snap.coins)}</b>` })));
    const grid = h('div', { class: 'zf-shop__grid' });
    for (const s of order()) {
      const owned = snap.owned.includes(s.id);
      const equipped = snap.equipped === s.id;
      let btn;
      if (equipped) btn = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost zf-btn--sm', disabled: true, text: 'Equipped' });
      else if (owned) {
        btn = h('button', { type: 'button', class: 'zf-btn zf-btn--solid zf-btn--sm', text: 'Equip' });
        btn.addEventListener('click', () => { locker.equip(s.id); sfx('confirm'); emit(EV.TOAST, { text: `${s.name} equipped`, kind: 'info', ms: 2200 }); });
      } else {
        const short = s.price - snap.coins;
        const isConfirm = confirming === s.id;
        btn = h('button', { type: 'button', class: 'zf-btn zf-btn--sm ' + (isConfirm ? 'zf-btn--primary' : 'zf-btn--solid'),
          disabled: short > 0, html: short > 0 ? `<span>${fmt(short)} more</span>` : isConfirm ? `<span>Confirm</span>${COIN_SVG}<span>${fmt(s.price)}</span>` : `${COIN_SVG}<span>${fmt(s.price)}</span>` });
        btn.addEventListener('click', () => {
          if (confirming !== s.id) { confirming = s.id; sfx('tick'); paint(); return; }
          confirming = null;
          const res = locker.buy(s.id);
          if (res.ok) {
            sfx('confirm');
            locker.equip(s.id);
            emit(EV.TOAST, { text: `${s.name} unlocked and equipped`, kind: 'info', ms: 3000 });
          } else { sfx('error'); emit(EV.TOAST, { text: res.reason, kind: 'warn', ms: 3000 }); paint(); }
        });
      }
      const item = h('article', { class: 'zf-skin' + (owned ? ' is-owned' : '') + (equipped ? ' is-equipped' : '') },
        card(s),
        h('div', { class: 'zf-skin__info' },
          h('h3', { class: 'zf-skin__name', text: s.name }),
          h('p', { class: 'zf-skin__blurb', text: s.blurb }),
          h('div', { class: 'zf-skin__foot' },
            h('span', { class: 'zf-skin__price', html: owned ? 'Owned' : s.price === 0 ? 'Free' : `${COIN_SVG}${fmt(s.price)}` }), btn)));
      grid.append(item);
    }
    el.append(grid);
    const lockerLink = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost zf-btn--sm zf-shop__locker', text: 'Open locker' });
    lockerLink.addEventListener('click', () => { sfx('confirm'); openLocker(); });
    el.append(lockerLink);
  };
  on(locker.LEV.CHANGED, () => { if (el.isConnected) paint(); });
  return { el, refresh: () => { confirming = null; paint(); } };
}

// ------------------------------------------------------------------------------------------ locker
export function buildLocker(openShop) {
  const el = h('div', { class: 'zf-locker' });
  const paint = () => {
    el.textContent = '';
    const snap = locker.snapshot();
    const cur = SKINS[snap.equipped] || SKINS.classic;
    const r = SKIN_RARITY[cur.rarity] || SKIN_RARITY.common;
    el.append(h('div', { class: 'zf-locker__hero' },
      card(cur, true),
      h('div', { class: 'zf-locker__meta' },
        h('p', { class: 'zf-label', text: 'Equipped' }),
        h('h3', { class: 'zf-locker__name', text: cur.name }),
        h('p', { class: 'zf-locker__rarity', style: { color: r.color }, text: r.label }),
        h('p', { class: 'zf-skin__blurb', text: cur.blurb }),
        h('p', { class: 'zf-locker__note', text: 'Other players see your skin in every online match from the next round on.' }))));
    const tiles = h('div', { class: 'zf-locker__tiles', role: 'listbox', 'aria-label': 'Skins' });
    for (const s of order()) {
      const owned = snap.owned.includes(s.id);
      const t = h('button', { type: 'button', role: 'option', 'aria-selected': String(snap.equipped === s.id),
        class: 'zf-locker__tile' + (owned ? '' : ' is-locked') + (snap.equipped === s.id ? ' is-equipped' : '') },
        card(s), h('span', { class: 'zf-locker__tilename', text: s.name }),
        h('span', { class: 'zf-locker__tilestate', html: snap.equipped === s.id ? 'Equipped' : owned ? 'Equip' : `${COIN_SVG}${fmt(s.price)}` }));
      t.addEventListener('click', () => {
        if (!owned) { sfx('tick'); openShop(); return; }
        if (locker.equip(s.id)) sfx('confirm');
      });
      tiles.append(t);
    }
    el.append(tiles);
  };
  on(locker.LEV.CHANGED, () => { if (el.isConnected) paint(); });
  return { el, refresh: paint };
}

/** Reward block for the results screen (or null when nothing was paid for this match). */
export function rewardBlock(matchId) {
  const r = locker.rewardFor(matchId);
  if (!r) return null;
  const list = h('ul', { class: 'zf-reward__parts' });
  for (const p of r.parts) list.append(h('li', { html: `<span>${esc(p.label)}</span><b>${p.coins >= 0 ? '+' : ''}${fmt(p.coins)}</b>` }));
  return h('div', { class: 'zf-reward' },
    h('div', { class: 'zf-reward__total', html: `${COIN_SVG}<b>+${fmt(r.coins)}</b><span>coins</span>` }), list,
    h('p', { class: 'zf-reward__bal', text: `Balance ${fmt(locker.coins())}` }));
}
