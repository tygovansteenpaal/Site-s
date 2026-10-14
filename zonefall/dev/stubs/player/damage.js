// ZONEFALL dev harness stand-in for src/combat/damage.js (PLAYER group). Not shipped in the game.
// Health-only maths for the local player (fall damage tests), regen after PLAYER.regenDelay, death at 0.
import { PLAYER } from '../../../src/config.js';
import { emit, EV } from '../../../src/core/bus.js';
import { state, localPlayer, LIFE } from '../../../src/core/state.js';

export function init() {}
export function damageAt() { return 0; }
export function dealHit() {}
export function applyToEntity(entity, amount) {
  const dealt = Math.min(entity.hp, amount);
  entity.hp -= dealt;
  return { killed: entity.hp <= 0, armorBroke: false, dealt };
}
export function applyToSelf(amount, info = {}) {
  const me = localPlayer();
  if (!me || !me.alive) return;
  const dealt = Math.min(me.hp, Math.max(0, amount));
  me.hp = Math.max(0, me.hp - dealt);
  state.local.lastDamageAt = performance.now();
  emit(EV.PLAYER_DAMAGED, { id: me.id, amount: dealt, hp: me.hp, armor: me.armor, armorBroke: false, from: info.from || null,
    weapon: info.weapon || null, zone: info.zone || null, dir: info.dir || null, kind: info.kind || 'bullet' });
  if (me.hp <= 0) kill(me.id, info.from || null, info.weapon || info.kind || 'fall', false, null);
}
export function kill(victimId, killerId, weapon, headshot) {
  const e = state.players.get(victimId);
  if (!e) return;
  e.alive = false;
  e.life = LIFE.DEAD;
  state.local.killer = { id: killerId, name: killerId || 'Gravity', weapon, headshot, distance: 0 };
  emit(EV.PLAYER_KILLED, { id: victimId, by: killerId, weapon, headshot, pos: [e.pos.x, e.pos.y, e.pos.z] });
}
export function explosionAt() {}
export function regen(entity, dt) {
  if (!entity.alive) return;
  if (performance.now() - state.local.lastDamageAt < PLAYER.regenDelay * 1000) return;
  entity.hp = Math.min(PLAYER.health, entity.hp + PLAYER.regenRate * dt);
}
export function update(dt) { const me = localPlayer(); if (me) regen(me, dt); }
export function validateHit() { return true; }
