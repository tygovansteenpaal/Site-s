// ZONEFALL - local inventory. OWNER: PLAYER. Contract: ARCHITECTURE.md 5.2 (Inventory and Item shapes in 5.4).
// Inventory = state.local.inv = {slots: [Slot|null, Slot|null], active: 0|1, ammo: {ar, light, sniper},
// plates: n (carried, <= PLAYER.armor.maxCarry), frags: n (<= WEAPONS.frag.maxCarry)}; Slot = {weapon: id, mag: rounds}.
// Every change emits INVENTORY {inv}. Pickups record an undo entry per item uid so revert() can undo a pickup that
// lost a loot claim conflict (ARCHITECTURE.md 8.5).
import { SPAWN_LOADOUT, PLAYER, WEAPONS, AMMO } from '../config.js';
import { emit, EV } from '../core/bus.js';
import { state, localPlayer } from '../core/state.js';

const AMMO_TYPES = Object.keys(AMMO);
const undo = new Map();               // item uid -> undo record of the last add()
const UNDO_KEEP = 48;

function fresh() {
  return { slots: [null, null], active: 0, ammo: { ar: 0, light: 0, sniper: 0 }, plates: 0, frags: 0 };
}

function inv() {
  if (!state.local.inv) state.local.inv = fresh();
  return state.local.inv;
}

function changed() { emit(EV.INVENTORY, { inv: state.local.inv }); }

function copySlot(s) {
  if (!s || !s.weapon) return null;
  if (!WEAPONS[s.weapon]) throw new Error(`[PLAYER/inventory] unknown weapon '${s.weapon}'`);
  return { weapon: s.weapon, mag: Math.max(0, Math.min(WEAPONS[s.weapon].mag | 0, s.mag | 0)) };
}

function capAmmo(type) { return AMMO[type] ? AMMO[type].max : 0; }

/** Reset to a loadout (default config.SPAWN_LOADOUT), deep-copied. Sets state.local.inv and the entity's weapon. */
export function reset(loadout = SPAWN_LOADOUT) {
  const l = loadout || SPAWN_LOADOUT;
  const v = fresh();
  const slots = Array.isArray(l.slots) ? l.slots : [];
  v.slots[0] = copySlot(slots[0]);
  v.slots[1] = copySlot(slots[1]);
  v.active = v.slots[0] ? 0 : v.slots[1] ? 1 : 0;
  for (const t of AMMO_TYPES) v.ammo[t] = Math.max(0, Math.min(capAmmo(t), (l.ammo && l.ammo[t]) | 0));
  v.plates = Math.max(0, Math.min(PLAYER.armor.maxCarry, l.plates | 0));
  v.frags = Math.max(0, Math.min(WEAPONS.frag.maxCarry, l.frags | 0));
  state.local.inv = v;
  undo.clear();
  const me = localPlayer();
  if (me) me.weapon = v.slots[v.active] ? v.slots[v.active].weapon : null;
  changed();
  return v;
}

/** The Inventory object (same reference as state.local.inv). */
export function get() { return inv(); }

/** Active slot {weapon, mag} or null. */
export function active() {
  const v = inv();
  return v.slots[v.active] || null;
}

/** Make slot i (0|1) active if it holds a weapon. Returns true if changed. */
export function select(i) {
  const v = inv();
  if ((i !== 0 && i !== 1) || !v.slots[i] || v.active === i) return false;
  v.active = i;
  changed();
  return true;
}

/** Switch to the other weapon slot if it holds a weapon. */
export function cycle(dir = 1) {
  const v = inv();
  const other = v.active === 0 ? 1 : 0;
  return dir === 0 ? false : select(other);
}

/** Whether picking up item would change anything (full ammo/plates/frags -> false; weapons always true). */
export function canTake(item) {
  if (!item) return false;
  const v = inv();
  switch (item.type) {
    case 'weapon': return !!WEAPONS[item.ref] && item.ref !== 'frag';
    case 'ammo': return AMMO[item.ref] ? v.ammo[item.ref] < capAmmo(item.ref) : false;
    case 'plate': return v.plates < PLAYER.armor.maxCarry;
    case 'frag': return v.frags < WEAPONS.frag.maxCarry;
    default: return false;
  }
}

/**
 * Take a loot item. Weapons go to an empty slot, else replace the active slot (the replaced weapon is returned in
 * dropped as an Item without uid/pos so game/loot can place it). Ammo/plates/frags are capped; leftovers are dropped.
 * The picked-up weapon becomes the active slot.
 * @returns {{taken:boolean, dropped:Array<{type:string, ref:string|null, qty:number}>}}
 */
export function add(item) {
  const v = inv();
  const dropped = [];
  if (!item || !canTake(item)) return { taken: false, dropped };
  const qty = Math.max(0, item.qty | 0);
  const rec = { type: item.type, ref: item.ref, slot: -1, prevSlot: null, prevActive: v.active, took: 0 };
  switch (item.type) {
    case 'weapon': {
      const w = WEAPONS[item.ref];
      const slot = { weapon: item.ref, mag: Math.min(w.mag, qty) };
      let i = v.slots[0] ? (v.slots[1] ? -1 : 1) : 0;
      if (i < 0) {
        i = v.active;
        const old = v.slots[i];
        rec.prevSlot = { weapon: old.weapon, mag: old.mag };
        dropped.push({ type: 'weapon', ref: old.weapon, qty: old.mag });
      }
      v.slots[i] = slot;
      v.active = i;
      rec.slot = i;
      rec.took = 1;
      break;
    }
    case 'ammo': {
      const take = Math.min(qty, capAmmo(item.ref) - v.ammo[item.ref]);
      v.ammo[item.ref] += take;
      rec.took = take;
      if (qty - take > 0) dropped.push({ type: 'ammo', ref: item.ref, qty: qty - take });
      break;
    }
    case 'plate': {
      const take = Math.min(qty, PLAYER.armor.maxCarry - v.plates);
      v.plates += take;
      rec.took = take;
      if (qty - take > 0) dropped.push({ type: 'plate', ref: null, qty: qty - take });
      break;
    }
    case 'frag': {
      const take = Math.min(qty, WEAPONS.frag.maxCarry - v.frags);
      v.frags += take;
      rec.took = take;
      if (qty - take > 0) dropped.push({ type: 'frag', ref: null, qty: qty - take });
      break;
    }
    default: return { taken: false, dropped };
  }
  if (item.uid != null) {
    undo.set(String(item.uid), rec);
    if (undo.size > UNDO_KEEP) undo.delete(undo.keys().next().value);
  }
  changed();
  return { taken: rec.took > 0, dropped };
}

/** Undo a pickup that lost a loot claim conflict (removes what add() gave, restores what it dropped). */
export function revert(item) {
  if (!item || item.uid == null) return false;
  const key = String(item.uid);
  const rec = undo.get(key);
  if (!rec) return false;
  undo.delete(key);
  const v = inv();
  switch (rec.type) {
    case 'weapon':
      if (rec.slot >= 0) {
        v.slots[rec.slot] = rec.prevSlot ? { ...rec.prevSlot } : null;
        v.active = v.slots[rec.prevActive] ? rec.prevActive : (v.slots[0] ? 0 : v.slots[1] ? 1 : 0);
      }
      break;
    case 'ammo': v.ammo[rec.ref] = Math.max(0, v.ammo[rec.ref] - rec.took); break;
    case 'plate': v.plates = Math.max(0, v.plates - rec.took); break;
    case 'frag': v.frags = Math.max(0, v.frags - rec.took); break;
    default: return false;
  }
  changed();
  return true;
}

/** Reserve rounds of an ammo type. */
export function ammo(type) {
  const v = inv();
  return v.ammo[type] | 0;
}

/** Remove up to n reserve rounds; returns the number removed. */
export function takeAmmo(type, n) {
  const v = inv();
  if (!(type in v.ammo)) return 0;
  const take = Math.max(0, Math.min(v.ammo[type], n | 0));
  if (!take) return 0;
  v.ammo[type] -= take;
  changed();
  return take;
}

/** Consume one carried plate (returns false if none). */
export function usePlate() {
  const v = inv();
  if (v.plates <= 0) return false;
  v.plates--;
  changed();
  return true;
}

/** Consume one frag (returns false if none). */
export function useFrag() {
  const v = inv();
  if (v.frags <= 0) return false;
  v.frags--;
  changed();
  return true;
}

/** Everything as Items (weapons with their mag, ammo, plates, frags) for the death drop; does not clear. */
export function dropAll() {
  const v = inv();
  const out = [];
  for (const s of v.slots) if (s && s.weapon) out.push({ type: 'weapon', ref: s.weapon, qty: s.mag | 0, tier: 0 });
  for (const t of AMMO_TYPES) if (v.ammo[t] > 0) out.push({ type: 'ammo', ref: t, qty: v.ammo[t], tier: 0 });
  if (v.plates > 0) out.push({ type: 'plate', ref: null, qty: v.plates, tier: 0 });
  if (v.frags > 0) out.push({ type: 'frag', ref: null, qty: v.frags, tier: 0 });
  return out;
}
