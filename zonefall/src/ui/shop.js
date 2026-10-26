// ZONEFALL - locker and shop panel (main menu side panel). OWNER: UI.
// One view for both: a detail strip for the selected outfit (big render, rarity, buy / equip) above a grid of every
// outfit. Today's featured outfits (ECONOMY.shopRotation, seeded by the local date so it changes at midnight) lead
// the grid. Buying and equipping go through core/profile; the equipped skin travels with the lobby info and the
// match roster, so other players and the spectate camera see it too.
import { on } from '../core/bus.js';
import { SKINS, SKIN_DEFAULT, RARITY, ECONOMY, assetUrl } from '../config.js';
import { Rng, hashString } from '../core/rng.js';
import * as profile from '../core/profile.js';
import { h, sfx } from './dom.js';

const thumbUrl = (id) => assetUrl(`skins/thumbs/${id}.webp`);
const fmt = (n) => n.toLocaleString('en-US');

/** Featured outfit ids for a date (local calendar day). */
export function featured(date = new Date()) {
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const rng = new Rng(hashString('shop:' + day));
  return rng.shuffle(Object.keys(SKINS).filter((k) => k !== SKIN_DEFAULT)).slice(0, ECONOMY.shopRotation);
}

export function mountShop() {
  let selected = profile.equipped();
  const coinsEl = h('span', { class: 'zf-shop__coins-n' });
  const head = h('div', { class: 'zf-shop__wallet' },
    h('span', { class: 'zf-coin', 'aria-hidden': 'true' }), coinsEl, h('span', { class: 'zf-shop__coins-l', text: 'coins' }),
    h('span', { class: 'zf-shop__earn', text: 'Earn coins by placing high and getting eliminations.' }));

  const dImg = h('img', { class: 'zf-shop__render', alt: '', draggable: 'false' });
  const dRarity = h('span', { class: 'zf-shop__rarity' });
  const dName = h('h3', { class: 'zf-shop__name' });
  const dNote = h('p', { class: 'zf-shop__note' });
  const dBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--primary zf-shop__act' });
  const detail = h('div', { class: 'zf-shop__detail' },
    h('div', { class: 'zf-shop__stage' }, dImg),
    h('div', { class: 'zf-shop__info' }, dRarity, dName, dNote, dBtn));

  const grid = h('div', { class: 'zf-shop__grid', role: 'listbox', 'aria-label': 'Outfits' });
  const el = h('div', { class: 'zf-shop' }, head, detail, h('h4', { class: 'zf-label zf-shop__sec', text: 'Outfits' }), grid);

  dBtn.addEventListener('click', () => {
    const p = profile.snapshot();
    if (p.skin === selected) return;
    if (p.owned.includes(selected)) { profile.equip(selected); sfx('confirm'); return; }
    const r = profile.buy(selected);
    if (r === 'ok') { profile.equip(selected); sfx('confirm'); }
    else { sfx('error'); dNote.textContent = r === 'coins' ? `You need ${fmt(SKINS[selected].price - p.coins)} more coins.` : 'Not available.'; }
  });

  function card(id, feat) {
    const s = SKINS[id];
    const tag = h('span', { class: 'zf-shop__tag' });
    const c = h('button', { type: 'button', class: 'zf-shop__card', role: 'option', data: { id, rarity: s.rarity || 'none' } },
      h('img', { src: thumbUrl(id), alt: '', loading: 'lazy', draggable: 'false' }),
      feat ? h('span', { class: 'zf-shop__feat', text: 'Featured' }) : null,
      h('span', { class: 'zf-shop__card-name', text: s.name }), tag);
    c.addEventListener('click', () => { selected = id; sfx('tick'); paint(); });
    c._tag = tag;
    return c;
  }

  function build() {
    grid.textContent = '';
    const feat = featured();
    const rest = Object.keys(SKINS).filter((k) => !feat.includes(k));
    for (const id of feat) grid.append(card(id, true));
    for (const id of rest) grid.append(card(id, false));
  }

  function paint() {
    const p = profile.snapshot();
    coinsEl.textContent = fmt(p.coins);
    for (const c of grid.children) {
      const id = c.dataset.id, own = p.owned.includes(id);
      c.classList.toggle('is-selected', id === selected);
      c.classList.toggle('is-owned', own);
      c.setAttribute('aria-selected', String(id === selected));
      c._tag.textContent = p.skin === id ? 'Equipped' : own ? 'Owned' : fmt(SKINS[id].price);
      c._tag.classList.toggle('is-price', !own);
    }
    const s = SKINS[selected], own = p.owned.includes(selected);
    dImg.src = thumbUrl(selected);
    detail.dataset.rarity = s.rarity || 'none';
    dRarity.textContent = s.rarity ? RARITY[s.rarity].label : 'Default';
    dName.textContent = s.name;
    dNote.textContent = p.skin === selected ? 'Worn in your next match.' : own ? 'In your locker.' : `${fmt(s.price)} coins`;
    dBtn.disabled = p.skin === selected;
    dBtn.classList.toggle('is-short', !own && p.coins < s.price);
    dBtn.textContent = '';
    dBtn.append(h('span', { text: p.skin === selected ? 'Equipped' : own ? 'Equip' : `Buy for ${fmt(s.price)}` }));
  }

  build();
  on(profile.PEV.PROFILE_CHANGED, paint);
  paint();
  return { el, refresh() { selected = profile.equipped(); build(); paint(); } };
}
