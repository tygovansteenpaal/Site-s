// ZONEFALL - character skins: wallet, owned skins, the equipped skin and coin rewards. OWNER: GAME (addition).
// Everything lives in this browser (localStorage, key LOCKER.storageKey); nothing is sent anywhere except the equipped
// skin id, which travels in 'hello' and the match roster so other players see it. Coins are earned per match:
// SKIN_REWARDS.match for playing, .kill per kill, .placement[place] for finishing high; paid once per match id when the
// local player is out (death) or the match ends, whichever comes first.
import { SKINS, SKIN_REWARDS, LOCKER } from '../config.js';
import { on, emit, EV, registerEvents } from '../core/bus.js';
import { state, debug } from '../core/state.js';
import { storage } from '../core/util.js';

export const LEV = registerEvents({
  CHANGED: 'locker:changed',            // {coins, owned:[id], equipped}
  REWARD: 'locker:reward',              // {matchId, coins, parts:[{label, coins}], total}
});

const DEFAULT = () => ({
  v: 1,
  coins: LOCKER.startCoins,
  owned: Object.values(SKINS).filter((s) => s.price === 0).map((s) => s.id),
  equipped: LOCKER.defaultSkin,
  paid: [],                             // match ids already rewarded (last 20)
  lastReward: null,
});

let data = null;

function load() {
  if (data) return data;
  let d = null;
  d = storage.get(LOCKER.storageKey, null);
  const def = DEFAULT();
  if (!d || typeof d !== 'object' || d.v !== 1) d = def;
  d.coins = Number.isFinite(d.coins) ? Math.max(0, Math.floor(d.coins)) : def.coins;
  d.owned = Array.isArray(d.owned) ? d.owned.filter((id) => SKINS[id]) : def.owned;
  for (const id of def.owned) if (!d.owned.includes(id)) d.owned.push(id);   // free skins added in later builds
  d.equipped = SKINS[d.equipped] && d.owned.includes(d.equipped) ? d.equipped : LOCKER.defaultSkin;
  d.paid = Array.isArray(d.paid) ? d.paid.slice(-20) : [];
  data = d;
  return data;
}

function save() {
  storage.set(LOCKER.storageKey, data);
  emit(LEV.CHANGED, snapshot());
}

/** {coins, owned, equipped} (copies). */
export function snapshot() {
  const d = load();
  return { coins: d.coins, owned: d.owned.slice(), equipped: d.equipped };
}

export const coins = () => load().coins;
export const owns = (id) => load().owned.includes(id);
export const equipped = () => load().equipped;

/** Buy a skin with coins. Returns {ok, reason}. */
export function buy(id) {
  const s = SKINS[id];
  const d = load();
  if (!s) return { ok: false, reason: 'Unknown skin' };
  if (d.owned.includes(id)) return { ok: false, reason: 'Already owned' };
  if (d.coins < s.price) return { ok: false, reason: `You need ${s.price - d.coins} more coins` };
  d.coins -= s.price;
  d.owned.push(id);
  save();
  return { ok: true };
}

/** Equip an owned skin; it is used from the next match (and sent to the lobby right away). */
export function equip(id) {
  const d = load();
  if (!SKINS[id] || !d.owned.includes(id)) return false;
  if (d.equipped === id) return true;
  d.equipped = id;
  save();
  return true;
}

/** Skin id for a bot in a match: seeded so every peer agrees (rng = core/rng stream for that bot). */
export function botSkin(rng) {
  const pool = Object.values(SKINS).filter((s) => s.bots > 0);
  let total = 0;
  for (const s of pool) total += s.bots;
  let r = rng.next() * total;
  for (const s of pool) { r -= s.bots; if (r <= 0) return s.id; }
  return LOCKER.defaultSkin;
}

/** Validate a skin id coming from the network or storage. */
export function cleanSkin(id) {
  return typeof id === 'string' && SKINS[id] ? id : LOCKER.defaultSkin;
}

function reward() {
  const m = state.match;
  if (!m || !m.id || m.phase === 'idle') return;
  const d = load();
  if (d.paid.includes(m.id)) return;
  const place = m.placement || 0;
  if (!place) return;
  const parts = [{ label: 'Match played', coins: SKIN_REWARDS.match }];
  const kills = (m.stats && m.stats.kills) || 0;
  if (kills) parts.push({ label: `${kills} kill${kills === 1 ? '' : 's'}`, coins: kills * SKIN_REWARDS.kill });
  const bonus = SKIN_REWARDS.placement.find((p) => place <= p.top);
  if (bonus) parts.push({ label: place === 1 ? 'Victory' : `Top ${bonus.top}`, coins: bonus.coins });
  let total = parts.reduce((a, p) => a + p.coins, 0);
  if (m.mode === 'practice') {
    total = Math.round(total * SKIN_REWARDS.practiceMult);
    parts.push({ label: 'Practice rate', coins: total - parts.reduce((a, p) => a + p.coins, 0) });
  }
  d.coins += total;
  d.paid.push(m.id);
  d.paid = d.paid.slice(-20);
  d.lastReward = { matchId: m.id, coins: total, parts };
  save();
  emit(LEV.REWARD, { matchId: m.id, coins: total, parts, total: d.coins });
}

/** The reward paid for a match id this session (results screen), or null. */
export function rewardFor(matchId) {
  const r = load().lastReward;
  return r && r.matchId === matchId ? r : null;
}

let inited = false;
export function init() {
  if (inited) return;
  inited = true;
  load();
  on(EV.PLAYER_KILLED, ({ id }) => { if (id === state.selfId) queueMicrotask(reward); });
  on(EV.MATCH_END, () => queueMicrotask(reward));
}

debug.game = Object.assign(debug.game || {}, {
  locker: { snapshot, buy, equip, reset: () => { data = DEFAULT(); save(); }, give: (n) => { load().coins += n | 0; save(); } },
});
