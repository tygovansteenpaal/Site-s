// ZONEFALL - the local player's profile: coins, owned skins and the equipped skin. OWNER: LEAD.
// Stored in this browser only (like settings). Coins are earned once per match, when the local placement is known
// (own death, or the match end for the winner); matchReward() decides the amount.
import { SKINS, SKIN_DEFAULT, ECONOMY, isSkin } from '../config.js';
import { on, emit, EV, registerEvents } from './bus.js';
import { state } from './state.js';
import { storage } from './util.js';

export const PEV = registerEvents({
  PROFILE_CHANGED: 'profile:changed',   // {coins, owned, skin, reward?: {coins, placement, kills}}
});

const KEY = 'zonefall.profile.v1';
let data = null;
let paidMatch = null;     // match id already rewarded

function load() {
  if (data) return data;
  const raw = storage.get(KEY, null) || {};
  const owned = new Set([SKIN_DEFAULT, ...(Array.isArray(raw.owned) ? raw.owned.filter(isSkin) : [])]);
  for (const [id, sk] of Object.entries(SKINS)) if (sk.price === 0) owned.add(id);   // free outfits
  data = {
    coins: Number.isFinite(raw.coins) ? Math.max(0, Math.floor(raw.coins)) : ECONOMY.startCoins,
    owned,
    skin: isSkin(raw.skin) && owned.has(raw.skin) ? raw.skin : SKIN_DEFAULT,
  };
  return data;
}

function save(extra) {
  storage.set(KEY, { coins: data.coins, owned: [...data.owned], skin: data.skin });
  emit(PEV.PROFILE_CHANGED, { ...snapshot(), ...extra });
}

/** @returns {{coins:number, owned:string[], skin:string}} */
export function snapshot() {
  const d = load();
  return { coins: d.coins, owned: [...d.owned], skin: d.skin };
}

export const coins = () => load().coins;
export const owns = (id) => load().owned.has(id);
export const equipped = () => load().skin;

/** Buy a skin. @returns {'ok'|'owned'|'coins'|'unknown'} */
export function buy(id) {
  const d = load();
  if (!isSkin(id)) return 'unknown';
  if (d.owned.has(id)) return 'owned';
  const price = SKINS[id].price;
  if (d.coins < price) return 'coins';
  d.coins -= price;
  d.owned.add(id);
  save();
  return 'ok';
}

/** Equip an owned skin; takes effect from the next match (lobby info and roster carry it). */
export function equip(id) {
  const d = load();
  if (!isSkin(id) || !d.owned.has(id)) return false;
  d.skin = id;
  save();
  return true;
}

/**
 * Coins for one finished match.
 * @param {{placement:number, players:number, kills:number, damage:number, survived:number}} r
 *   placement 1 = winner; players = roster size; survived in seconds.
 * @returns {number} whole coins, >= 0
 */
export function matchReward(r) {
  // TODO(you): the reward formula. It sets how fast skins unlock: rare 800, epic 1200, legendary 2000 coins.
  return 0;
}

function payout() {
  const m = state.match;
  if (!m.id || paidMatch === m.id || !m.placement) return;
  paidMatch = m.id;
  const r = {
    placement: m.placement, players: m.roster.length, kills: m.stats.kills | 0,
    damage: Math.round(m.stats.damage || 0), survived: Math.round(m.stats.survived || 0),
  };
  const n = Math.max(0, Math.floor(matchReward(r) || 0));
  const d = load();
  d.coins += n;
  save({ reward: { coins: n, placement: r.placement, kills: r.kills, mid: m.id } });
}

export function init() {
  load();
  // the placement is written by game/match in the same PLAYER_KILLED handler; read it a tick later
  on(EV.PLAYER_KILLED, ({ id }) => { if (id === state.selfId) queueMicrotask(payout); });
  on(EV.MATCH_END, () => queueMicrotask(payout));
}

/** The latest reward of this session (end screen), or null. */
export function lastReward() { return lastRewardInfo; }
let lastRewardInfo = null;
on(PEV.PROFILE_CHANGED, (p) => { if (p.reward) lastRewardInfo = p.reward; });
