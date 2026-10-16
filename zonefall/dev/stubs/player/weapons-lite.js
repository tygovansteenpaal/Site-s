// ZONEFALL dev harness helper (PLAYER group): a minimal stand-in for combat/weapons so the player modules can be
// exercised: ADS ramp (WEAPONS[w].ads seconds), fire with the ARCHITECTURE.md 6.3 recoil pattern through
// camera.addRecoil, magazine use, reload with the cue events, grenade throw and plate flags, weapon switching through
// the real player/inventory. Not shipped in the game.
import * as THREE from 'three';
import { WEAPONS, PLAYER } from '../../../src/config.js';
import { emit, EV } from '../../../src/core/bus.js';
import { state, localPlayer, LIFE, FLAG, setFlag, hasFlag } from '../../../src/core/state.js';
import * as input from '../../../src/engine/input.js';
import * as camera from '../../../src/player/camera.js';
import * as inventory from '../../../src/player/inventory.js';

let cooldown = 0, shotIndex = 0, lastShot = -1e9, firingT = 0;
let reload = null, throwT = -1, plateT = -1, boltT = 0, forceAds = false;

/** Hold ADS without the mouse (harness button and automated tests). */
export function setForceAds(on) { forceAds = !!on; }
const o = new THREE.Vector3(), d = new THREE.Vector3();

function active() { return inventory.active(); }

export function update(dt) {
  const me = localPlayer();
  if (!me) return;
  const L = state.local;
  const slot = active();
  me.weapon = slot ? slot.weapon : null;
  const W = me.weapon ? WEAPONS[me.weapon] : null;
  const ground = me.life === LIFE.GROUND && me.alive;
  const sprint = hasFlag(me, FLAG.SPRINT);
  // switching
  if (ground && !reload && throwT < 0 && plateT < 0) {
    let sel = -1;
    if (input.pressed('slot1')) sel = 0;
    if (input.pressed('slot2')) sel = 1;
    if (input.pressed('swap')) sel = inventory.get().active === 0 ? 1 : 0;
    if (sel >= 0 && inventory.select(sel)) { emit(EV.WEAPON_SWITCH, { id: me.id, weapon: active().weapon }); L.ads = 0; }
  }
  // ADS
  const wantAds = ground && W && (input.down('ads') || forceAds) && !sprint && throwT < 0 && plateT < 0;
  const rate = W ? 1 / Math.max(0.05, W.ads) : 6;
  const prevAds = L.ads;
  L.ads = Math.max(0, Math.min(1, L.ads + (wantAds ? rate : -rate * 1.3) * dt));
  if ((prevAds < 0.5) !== (L.ads < 0.5)) emit(EV.ADS, { active: L.ads >= 0.5 });
  L.scoped = !!(W && W.scope && L.ads > 0.92);
  setFlag(me, FLAG.ADS, L.ads > 0.5);
  // fire
  cooldown -= dt; boltT -= dt;
  if (performance.now() - lastShot > 250) shotIndex = 0;
  const canFire = ground && W && !sprint && !reload && throwT < 0 && plateT < 0 && cooldown <= 0 && boltT <= 0;
  const trigger = W && (W.mode === 'auto' ? input.down('fire') : input.pressed('fire'));
  if (canFire && trigger) {
    if (slot.mag <= 0) {
      if (input.pressed('fire')) emit(EV.WEAPON_DRY, { id: me.id, weapon: me.weapon });
    } else {
      slot.mag--;
      cooldown = 60 / W.rpm;
      camera.getAimRay(o, d);
      emit(EV.WEAPON_FIRE, { id: me.id, weapon: me.weapon, origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z],
        end: [o.x + d.x * 100, o.y + d.y * 100, o.z + d.z * 100], local: true, hit: null });
      const r = W.recoil, i = shotIndex, k = L.ads > 0.5 ? 1 : r.hipMult;
      const pitch = r.vKick * (i === 0 ? r.firstShot : 1) * (1 + r.vRamp * Math.min(i, r.rampShots) / r.rampShots) * k;
      const yaw = (r.hKick * Math.sin(i * r.hFreq) + r.hBias + (Math.random() * 2 - 1) * r.hJitter) * k;
      camera.addRecoil(pitch, yaw);
      camera.addShake(r.shake * 0.3, 0.18);
      shotIndex++;
      lastShot = performance.now();
      firingT = 0.15;
      if (W.mode === 'bolt') { boltT = W.boltTime; emit(EV.WEAPON_BOLT, { id: me.id, weapon: me.weapon }); }
      emit(EV.INVENTORY, { inv: inventory.get() });
    }
  }
  firingT -= dt;
  setFlag(me, FLAG.FIRING, firingT > 0);
  // reload
  if (ground && W && !reload && input.pressed('reload') && slot.mag < W.mag && inventory.ammo(W.ammo) > 0 && throwT < 0 && plateT < 0) {
    const empty = slot.mag === 0;
    reload = { t: 0, dur: empty ? W.reloadEmpty : W.reload, empty, cues: { ...W.reloadCues }, fired: {} };
    L.ads = 0;
    emit(EV.WEAPON_RELOAD, { id: me.id, weapon: me.weapon, phase: 'start', empty });
  }
  if (reload) {
    reload.t += dt;
    const u = reload.t / reload.dur;
    for (const c of ['magout', 'magin', 'charge']) {
      if (!reload.fired[c] && u >= reload.cues[c] && (c !== 'charge' || reload.empty)) { reload.fired[c] = true; emit(EV.WEAPON_RELOAD, { id: me.id, weapon: me.weapon, phase: c, empty: reload.empty }); }
    }
    L.action = 'reload'; L.actionT = Math.min(1, u);
    if (u >= 1) {
      const need = W.mag - slot.mag;
      slot.mag += inventory.takeAmmo(W.ammo, need);
      emit(EV.WEAPON_RELOAD, { id: me.id, weapon: me.weapon, phase: 'end', empty: reload.empty });
      reload = null; L.action = null; L.actionT = 0;
    }
  }
  setFlag(me, FLAG.RELOAD, !!reload);
  // grenade
  if (ground && throwT < 0 && !reload && plateT < 0 && input.pressed('grenade') && inventory.get().frags > 0) { throwT = 0; L.ads = 0; }
  if (throwT >= 0) {
    throwT += dt;
    if (throwT >= 0.95) { inventory.useFrag(); throwT = -1; }
  }
  setFlag(me, FLAG.THROW, throwT >= 0);
  // plates
  if (ground && plateT < 0 && !reload && throwT < 0 && input.pressed('plate') && inventory.get().plates > 0 && me.armor < PLAYER.armor.slots * PLAYER.armor.perPlate) {
    plateT = 0; L.ads = 0;
    emit(EV.PLATE_START, { id: me.id });
  }
  if (plateT >= 0) {
    plateT += dt;
    if (plateT >= PLAYER.armor.insertTime) {
      inventory.usePlate();
      me.armor = Math.min(PLAYER.armor.slots * PLAYER.armor.perPlate, me.armor + PLAYER.armor.perPlate);
      emit(EV.PLATE_DONE, { id: me.id, armor: me.armor });
      plateT = -1;
    }
  }
  setFlag(me, FLAG.PLATE, plateT >= 0);
}

export function busy() { return !!reload || throwT >= 0 || plateT >= 0; }
