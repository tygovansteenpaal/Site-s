// ZONEFALL dev harness stand-in for src/game/bots.js (COMBAT group firing range). Not shipped in the game.
// Range targets are bot entities (rendered by player/avatar like any bot) that stand on their lanes facing the firing
// line. applyDamage runs the real combat/damage maths (armor first, then health) and kills through damage.kill, so
// hitmarkers, kill events, death animations and drops are the production path. Dead targets stand up again after
// RESPAWN seconds with the configured armor. Optional strafing makes them move side to side.

import { state, getPlayer, createPlayer, LIFE, FLAG, setFlag } from '../../../src/core/state.js';
import * as damage from '../../../src/combat/damage.js';

const RESPAWN = 2.6;
const targets = [];           // {id, home: [x, y, z], weapon, deadT, phase}
let armorLevel = 0, moving = false, crouching = false, t = 0;

export function init() {}
export function setup() {}
export function takeOver() {}
export function list() { return targets.map((g) => g.id); }

/** Harness: create a target bot at home [x, y, z] facing yaw. */
export function addTarget(slot, name, home, yaw, weapon) {
  const id = `bot:${slot}`;
  const e = createPlayer({ id, name, kind: 'bot', owner: state.selfId, slot });
  e.life = LIFE.GROUND; e.alive = true; e.hp = 100; e.armor = armorLevel; e.weapon = weapon; e.yaw = yaw; e.pitch = 0;
  e.pos.set(home[0], home[1], home[2]);
  targets.push({ id, home: home.slice(), weapon, deadT: -1, phase: slot * 1.7, yaw });
  return e;
}
export function setArmor(v) { armorLevel = v; for (const g of targets) { const e = getPlayer(g.id); if (e && e.alive) e.armor = v; } }
export function setMoving(on) { moving = !!on; }
export function setCrouch(on) { crouching = !!on; }
export function resetAll() {
  for (const g of targets) revive(g);
}
function revive(g) {
  const e = getPlayer(g.id);
  if (!e) return;
  e.alive = true; e.life = LIFE.GROUND; e.hp = 100; e.armor = armorLevel; e.weapon = g.weapon; e.yaw = g.yaw;
  e.pos.set(g.home[0], g.home[1], g.home[2]);
  g.deadT = -1;
}

export function update(dt) {
  t += dt;
  for (const g of targets) {
    const e = getPlayer(g.id);
    if (!e) continue;
    if (!e.alive) {
      if (g.deadT < 0) g.deadT = 0;
      g.deadT += dt;
      if (g.deadT > RESPAWN) revive(g);
      continue;
    }
    const sx = moving ? Math.sin(t * 0.9 + g.phase) * 2.2 : 0;
    const vx = moving ? Math.cos(t * 0.9 + g.phase) * 2.2 * 0.9 : 0;
    e.pos.x = g.home[0] + sx;
    e.vel.set(vx, 0, 0);
    e.speed = Math.abs(vx);
    setFlag(e, FLAG.CROUCH, crouching);
    setFlag(e, FLAG.ADS, true);
    damage.regen(e, dt);
  }
}

/** Host: apply damage to a bot (combat/damage.applyToEntity); on death combat/damage.kill. */
export function applyDamage(id, amount, info = {}) {
  const e = getPlayer(id);
  if (!e || !e.alive) return null;
  const r = damage.applyToEntity(e, amount, info);
  if (r.killed) damage.kill(id, info.from || null, info.weapon || 'frag', info.zone === 'head', info.sid ?? null);
  return r;
}

