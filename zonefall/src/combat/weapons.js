// ZONEFALL - local weapon handling. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 6 (gun feel).
// One state machine for the local player: idle | firing | reloading | switching | plating | throwing | bolting.
// Reads input (fire, ads, reload, slot1/2, swap, plate, grenade, sprint = hold breath while scoped) only when the local
// entity is GROUND and alive. Fire: rate from rpm (fractional cooldown, exact at any frame rate), modes auto / semi
// (buffered press) / bolt, sprint-to-fire delay, spread cone (state.local.spread) from config spread params, the
// recoil pattern of ARCHITECTURE.md 6.3 -> camera.addRecoil, viewmodel.kick, camera.addShake(recoil.shake x 0.3),
// ballistics.fire(...). Reload with cue events (WEAPON_RELOAD magout / magin / charge at reloadCues fractions; ammo
// moves at magin), cancelled by firing while rounds remain (before the magazine is out), switching or a grenade.
// ADS: state.local.ads approaches 1 over WEAPONS[w].ads seconds (drops while sprinting, switching, plating, throwing
// and during the M700 bolt cycle), adsFov = vertical FOV x adsFovMult, scoped = scope && ads > 0.9, with Lissajous
// scope sway (the shot follows the swayed reticle) and hold breath on sprint for holdBreath seconds, after which
// sway doubles until breath refills. Plates: the plate key inserts one plate (PLAYER.armor.insertTime), holding it
// continues to the next (PLATE_START / PLATE_DONE); grenade: hold G cooks (pin sound), release throws through
// grenades.throwLocal(cook); cook >= fuse explodes in hand. Writes ADS/FIRING/RELOAD/THROW/PLATE flags,
// entity.weapon and the state.local weapon fields.
// Extra exports (COMBAT additions): viewState() for the viewmodel, getSway(), setForceAds(on), setForceFire(on) (tests).
import * as THREE from 'three';
import { WEAPONS, PLAYER, AMMO } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, localPlayer, LIFE, FLAG, setFlag, hasFlag, debug } from '../core/state.js';
import * as settings from '../core/settings.js';
import { clamp, damp, DEG, settingsFovToVertical } from '../core/util.js';
import * as input from '../engine/input.js';
import { AEV } from '../engine/audio.js';
import * as inventory from '../player/inventory.js';
import * as camera from '../player/camera.js';
import * as controller from '../player/controller.js';
import * as ballistics from './ballistics.js';
import * as damage from './damage.js';
import * as grenades from './grenades.js';
import * as viewmodel from './viewmodel.js';

const TUNE = {
  lowerTime: 0.22,            // s to lower the old weapon on a switch (raise time is WEAPONS[w].raise)
  burstReset: 0.25,           // s without firing before the recoil pattern restarts
  semiBuffer: 0.14,           // s a semi-auto press is remembered while the gun cycles
  firingFlag: 0.15,           // s FIRING stays set after a shot (remote anims)
  adsOutFactor: 0.75,         // leaving ADS is this fraction of the ADS time
  autoReloadDelay: 0.22,      // s after the last round with the trigger up
  boltOpenAt: 0.16,           // fraction of boltTime when the bolt is worked (sound + anim start)
  minWindup: 0.24,            // s a grenade must be held before it can leave the hand
  releaseAt: 0.17,            // s into the throw when the grenade leaves the hand
  crouchSpread: 0.8,
  scopeSway: { f1: 1.13, f2: 2.71, f3: 1.71, f4: 3.31, hold: 0.12, tired: 2.0, crouch: 0.7, move: 1.7 },
  breathRefill: 0.8,          // x holdBreath seconds to refill completely
  maxShotsPerFrame: 3,
};

// ------------------------------------------------------------------------------------------ module state
const vs = {
  drawn: null,              // weapon id in hand
  switchPhase: 'none',      // 'none' | 'lower' | 'raise'
  switchT: 0, switchDur: 0, switchTo: -1,
  reload: null,             // {t, dur, empty, weapon, fired:{}, u}
  boltT: -1, boltDur: 1, boltEmitted: false,   // bolt cycle seconds elapsed (-1 idle)
  plate: null,              // {t}
  nade: null,               // {phase:'cook'|'throw'|'recover', t, cook, thrown}
  sprint: 0,                // 0..1 sprint pose blend
  sinceShot: 9, shots: 0,   // seconds since the last shot, total shots
  sinceSprint: 9,
  sway: { yaw: 0, pitch: 0 },
  holdingBreath: false,
  swim: false,
  lastAmmoLow: false,
};
let fireCd = 0, shotIndex = 0, semiBuf = 0, bloom = 0, firingT = 0, autoReloadT = -1;
let swayT = Math.random() * 100, breathTired = false;
let forceAds = false, forceFire = false, lastForceFire = false;
let lastAdsActive = false;
let inited = false;
const aimO = new THREE.Vector3(), aimD = new THREE.Vector3(), tmpR = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();

function err(msg) { return new Error(`[COMBAT/weapons] ${msg}`); }
const W_ = (id) => (id ? WEAPONS[id] : null);

// ------------------------------------------------------------------------------------------ public API
export function init() {
  if (inited) return;
  inited = true;
  on(EV.MATCH_START, resetAll);
  on(EV.PLAYER_KILLED, ({ id }) => { if (id === state.selfId) { cancelActions(); state.local.ads = 0; state.local.scoped = false; } });
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    give: (id, slot = null) => give(id, slot),
    fillAmmo: () => fillAmmo(),
    setForceAds: (on) => setForceAds(on),
    setForceFire: (on) => setForceFire(on),
    weaponState: () => ({
      drawn: vs.drawn, switch: vs.switchPhase, reload: vs.reload ? +vs.reload.u.toFixed(2) : null, bolt: vs.boltT, plate: vs.plate ? +vs.plate.t.toFixed(2) : null,
      nade: vs.nade ? vs.nade.phase : null, ads: +state.local.ads.toFixed(2), spread: +state.local.spread.toFixed(2), scoped: state.local.scoped,
      breath: +state.local.breath.toFixed(2), sway: [+vs.sway.yaw.toFixed(3), +vs.sway.pitch.toFixed(3)], shots: vs.shots,
      mag: inventory.active() ? inventory.active().mag : null,
    }),
  });
}

/** The viewmodel's read-only view of the weapon state machine (same object every call). */
export function viewState() { return vs; }
/** Scope sway in degrees {yaw (right +), pitch (up +)}; zero unless scoped. */
export function getSway() { return vs.sway; }
/** Hold ADS / fire without input (harness buttons and automated tests). */
export function setForceAds(on) { forceAds = !!on; }
export function setForceFire(on) { forceFire = !!on; }

/** True while an action blocks interaction (reload, plate, throw, switch). */
export function isBusy() { return !!vs.reload || !!vs.plate || !!vs.nade || vs.switchPhase !== 'none'; }

/** Abort reload/plating/cook (on death, on leaving GROUND). A grenade being cooked is dropped at the feet. */
export function cancelActions() {
  const me = localPlayer();
  if (vs.reload) {
    if (me) emit(EV.WEAPON_RELOAD, { id: me.id, weapon: vs.reload.weapon, phase: 'cancel', empty: vs.reload.empty });
    vs.reload = null;
  }
  vs.plate = null;
  if (vs.nade) {
    if (vs.nade.phase === 'cook' || (vs.nade.phase === 'throw' && !vs.nade.thrown)) {
      if (inventory.useFrag()) grenades.dropLocal(vs.nade.cook);
    }
    vs.nade = null;
  }
  if (vs.switchPhase === 'lower' && vs.switchTo >= 0) { inventory.select(vs.switchTo); }
  vs.switchPhase = 'none';
  state.local.action = null; state.local.actionT = 0; state.local.cook = 0;
  if (me) setFlag(me, FLAG.RELOAD | FLAG.PLATE | FLAG.THROW, false);
  autoReloadT = -1;
}

// ------------------------------------------------------------------------------------------ helpers
function resetAll() {
  vs.drawn = null; vs.switchPhase = 'none'; vs.reload = null; vs.boltT = -1; vs.plate = null; vs.nade = null;
  vs.sprint = 0; vs.sinceShot = 9; vs.sinceSprint = 9;
  fireCd = 0; shotIndex = 0; semiBuf = 0; bloom = 0; firingT = 0; autoReloadT = -1; breathTired = false;
  const L = state.local;
  L.ads = 0; L.adsFov = 0; L.scoped = false; L.spread = 0; L.action = null; L.actionT = 0; L.cook = 0; L.breath = 1;
}

function give(id, slot) {
  const W = WEAPONS[id];
  if (!W || W.class === 'lethal') throw err(`give: unknown weapon '${id}'`);
  const inv = inventory.get();
  if (slot === 0 || slot === 1) {
    inv.slots[slot] = { weapon: id, mag: W.mag };
    inventory.select(slot);
    emit(EV.INVENTORY, { inv });
    return inv;
  }
  const r = inventory.add({ uid: `dbg${Math.random().toString(36).slice(2, 8)}`, type: 'weapon', ref: id, qty: W.mag, pos: [0, 0, 0], tier: 0 });
  return r;
}

function fillAmmo() {
  for (const t of Object.keys(AMMO)) inventory.add({ uid: `dbga${t}${Date.now()}`, type: 'ammo', ref: t, qty: AMMO[t].max, pos: [0, 0, 0], tier: 0 });
  inventory.add({ uid: `dbgp${Date.now()}`, type: 'plate', ref: null, qty: PLAYER.armor.maxCarry, pos: [0, 0, 0], tier: 0 });
  inventory.add({ uid: `dbgf${Date.now()}`, type: 'frag', ref: null, qty: WEAPONS.frag.maxCarry, pos: [0, 0, 0], tier: 0 });
  const inv = inventory.get();
  for (const s of inv.slots) if (s) s.mag = WEAPONS[s.weapon].mag;
  emit(EV.INVENTORY, { inv });
  return inv;
}

function baseVFov() { return settingsFovToVertical(settings.get('fov')); }

function startSwitch(me, toSlot) {
  const inv = inventory.get();
  if (toSlot === inv.active || !inv.slots[toSlot]) return false;
  if (vs.reload) { emit(EV.WEAPON_RELOAD, { id: me.id, weapon: vs.reload.weapon, phase: 'cancel', empty: vs.reload.empty }); vs.reload = null; }
  vs.plate = null;
  vs.switchPhase = vs.drawn ? 'lower' : 'raise';
  vs.switchT = 0;
  vs.switchTo = toSlot;
  vs.switchDur = vs.drawn ? TUNE.lowerTime : W_(inv.slots[toSlot].weapon).raise;
  if (!vs.drawn) { inventory.select(toSlot); vs.drawn = inv.slots[toSlot].weapon; }
  emit(EV.WEAPON_SWITCH, { id: me.id, weapon: inv.slots[toSlot].weapon });
  return true;
}

function startRaise(id) {
  vs.drawn = id;
  vs.switchPhase = id ? 'raise' : 'none';
  vs.switchT = 0;
  vs.switchDur = id ? W_(id).raise : 0;
  vs.switchTo = -1;
  vs.boltT = -1;
}

function startReload(me, slot, W) {
  if (!slot || slot.mag >= W.mag || inventory.ammo(W.ammo) <= 0) return false;
  const empty = slot.mag === 0;
  vs.reload = { t: 0, dur: empty ? W.reloadEmpty : W.reload, empty, weapon: slot.weapon, fired: {}, u: 0 };
  vs.boltT = -1;
  autoReloadT = -1;
  emit(EV.WEAPON_RELOAD, { id: me.id, weapon: slot.weapon, phase: 'start', empty });
  return true;
}

/** Recoil for shot i of a burst (ARCHITECTURE.md 6.3), degrees. */
function recoilFor(W, i, ads) {
  const r = W.recoil;
  const k = ads > 0.5 ? 1 : r.hipMult;
  const pitch = r.vKick * (i === 0 ? r.firstShot : 1) * (1 + r.vRamp * Math.min(i, r.rampShots) / r.rampShots) * k;
  const yaw = (r.hKick * Math.sin(i * r.hFreq) + r.hBias + (Math.random() * 2 - 1) * r.hJitter) * k;
  return [pitch, yaw];
}

function shoot(me, slot, W) {
  slot.mag--;
  const L = state.local;
  camera.getAimRay(aimO, aimD);
  // Scope sway moves the reticle; the round goes where the reticle is.
  if (L.scoped && (vs.sway.yaw || vs.sway.pitch)) {
    tmpR.crossVectors(aimD, UP).normalize();
    qa.setFromAxisAngle(UP, -vs.sway.yaw * DEG);
    qb.setFromAxisAngle(tmpR, vs.sway.pitch * DEG);
    aimD.applyQuaternion(qb).applyQuaternion(qa).normalize();
  }
  ballistics.fire(me.id, slot.weapon, aimO, aimD, { spreadDeg: L.spread, seq: (vs.shots + 1) & 0xffff });
  const [rp, ry] = recoilFor(W, shotIndex, L.ads);
  camera.addRecoil(rp, ry);
  camera.addShake(W.recoil.shake * 0.3, 0.16);
  viewmodel.kick(slot.weapon);
  shotIndex++;
  vs.shots++;
  vs.sinceShot = 0;
  firingT = TUNE.firingFlag;
  if (L.ads < 0.5) bloom = Math.min(bloom + W.spread.bloom, Math.max(0, W.spread.max - W.spread.hip));
  if (W.mode === 'bolt') { vs.boltT = 0; vs.boltDur = W.boltTime; vs.boltEmitted = false; }
  if (slot.mag === 0 && inventory.ammo(W.ammo) > 0) autoReloadT = TUNE.autoReloadDelay;
  emit(EV.INVENTORY, { inv: inventory.get() });
}

// ------------------------------------------------------------------------------------------ update
export function update(dt) {
  const me = localPlayer();
  const L = state.local;
  if (!me) return;
  const inv = state.local.inv;
  const slot = inv ? inv.slots[inv.active] || null : null;
  const activeId = slot ? slot.weapon : null;

  // ---- external weapon changes (pickup into the active slot, inventory reset): raise the new weapon
  if (vs.switchPhase !== 'lower' && activeId !== vs.drawn) startRaise(activeId);
  me.weapon = vs.drawn;

  let swim = false;
  try { swim = controller.stanceInfo().stance === 'swim'; } catch (e) { swim = false; }
  vs.swim = swim;
  const ground = me.alive && me.life === LIFE.GROUND;
  const able = ground && !swim;
  if (!able) {
    if (vs.reload || vs.plate || vs.nade) cancelActions();
    L.ads = Math.max(0, L.ads - dt * 6);
  }

  const sprinting = hasFlag(me, FLAG.SPRINT);
  vs.sprint = damp(vs.sprint, sprinting && ground ? 1 : 0, sprinting ? 9 : 11, dt);
  vs.sinceSprint = sprinting ? 0 : vs.sinceSprint + dt;
  vs.sinceShot += dt;
  firingT -= dt;
  fireCd -= dt;
  semiBuf -= dt;

  // ---- switching
  if (vs.switchPhase !== 'none') {
    vs.switchT += dt;
    if (vs.switchT >= vs.switchDur) {
      if (vs.switchPhase === 'lower') {
        if (vs.switchTo >= 0) inventory.select(vs.switchTo);
        const s2 = inventory.active();
        startRaise(s2 ? s2.weapon : null);
        me.weapon = vs.drawn;
      } else { vs.switchPhase = 'none'; vs.switchT = 0; }
    }
  }
  if (able && !vs.nade && !vs.plate && vs.switchPhase !== 'lower') {
    let sel = -1;
    if (input.pressed('slot1')) sel = 0;
    if (input.pressed('slot2')) sel = 1;
    if (input.pressed('swap')) sel = inv && inv.active === 0 ? 1 : 0;
    if (sel >= 0 && inv && inv.slots[sel] && sel !== inv.active) startSwitch(me, sel);
  }

  const Wd = W_(vs.drawn);
  const switching = vs.switchPhase !== 'none';

  // ---- reload
  if (vs.reload) {
    const R = vs.reload, Wr = W_(R.weapon);
    R.t += dt;
    R.u = Math.min(1, R.t / R.dur);
    const cues = Wr.reloadCues;
    for (const c of ['magout', 'magin', 'charge']) {
      if (R.fired[c] || R.u < cues[c]) continue;
      if (c === 'charge' && !R.empty) { R.fired[c] = true; continue; }
      R.fired[c] = true;
      if (c === 'magin') {
        const s = inv.slots.find((x) => x && x.weapon === R.weapon);
        if (s) { const need = Wr.mag - s.mag; s.mag += inventory.takeAmmo(Wr.ammo, need); }
      }
      emit(EV.WEAPON_RELOAD, { id: me.id, weapon: R.weapon, phase: c, empty: R.empty });
    }
    if (R.u >= 1) {
      emit(EV.WEAPON_RELOAD, { id: me.id, weapon: R.weapon, phase: 'end', empty: R.empty });
      vs.reload = null;
      emit(EV.INVENTORY, { inv: inventory.get() });
    } else if (R.weapon !== vs.drawn) {
      emit(EV.WEAPON_RELOAD, { id: me.id, weapon: R.weapon, phase: 'cancel', empty: R.empty });
      vs.reload = null;
    }
  }

  // ---- bolt cycle (M700)
  if (vs.boltT >= 0) {
    vs.boltT += dt;
    if (!vs.boltEmitted && vs.boltT >= vs.boltDur * TUNE.boltOpenAt) { vs.boltEmitted = true; emit(EV.WEAPON_BOLT, { id: me.id, weapon: vs.drawn }); }
    if (vs.boltT >= vs.boltDur) vs.boltT = -1;
  }

  // ---- grenades
  const F = WEAPONS.frag;
  if (vs.nade) {
    const N = vs.nade;
    N.t += dt;
    if (N.phase === 'cook') {
      N.cook += dt;
      L.cook = N.cook;
      if (N.cook >= F.fuse) {
        // held too long: it goes off in the hand
        if (inventory.useFrag()) grenades.throwLocal(F.fuse);
        vs.nade = { phase: 'recover', t: 0, cook: 0, thrown: true };
      } else if (!input.down('grenade') && N.t >= TUNE.minWindup) {
        N.phase = 'throw'; N.t = 0;
      }
    } else if (N.phase === 'throw') {
      N.cook += dt;
      L.cook = N.cook;
      if (!N.thrown && N.t >= TUNE.releaseAt) {
        N.thrown = true;
        if (inventory.useFrag()) grenades.throwLocal(N.cook);
      }
      if (N.t >= F.throwTime) { vs.nade = null; startRaise(vs.drawn); }
    } else if (N.t >= 0.35) { vs.nade = null; startRaise(vs.drawn); }
    if (vs.nade && vs.nade.phase !== 'cook' && vs.nade.phase !== 'throw') L.cook = 0;
  } else L.cook = 0;
  if (able && !vs.nade && input.pressed('grenade') && inv && inv.frags > 0 && !vs.plate) {
    if (vs.reload) { emit(EV.WEAPON_RELOAD, { id: me.id, weapon: vs.reload.weapon, phase: 'cancel', empty: vs.reload.empty }); vs.reload = null; }
    vs.nade = { phase: 'cook', t: 0, cook: 0, thrown: false };
    emit(AEV.COOK, { id: me.id });
  }
  grenades.setPreview(!!(vs.nade && vs.nade.phase === 'cook'), vs.nade ? vs.nade.cook : 0);

  // ---- plates
  const armorFull = (me.armor || 0) >= damage.maxArmor() - 0.01;
  if (vs.plate) {
    vs.plate.t += dt;
    if (input.pressed('fire') || input.pressed('reload') || vs.nade || switching) { vs.plate = null; }
    else if (vs.plate.t >= PLAYER.armor.insertTime) {
      if (inventory.usePlate()) {
        const a = damage.addArmor(me, PLAYER.armor.perPlate);
        emit(EV.PLATE_DONE, { id: me.id, armor: a });
      }
      vs.plate = null;
      if (input.down('plate') && inv.plates > 0 && (me.armor || 0) < damage.maxArmor() - 0.01) { vs.plate = { t: 0 }; emit(EV.PLATE_START, { id: me.id }); }
    }
  } else if (able && input.pressed('plate') && inv && inv.plates > 0 && !armorFull && !vs.nade && !switching) {
    if (vs.reload) { emit(EV.WEAPON_RELOAD, { id: me.id, weapon: vs.reload.weapon, phase: 'cancel', empty: vs.reload.empty }); vs.reload = null; }
    vs.plate = { t: 0 };
    emit(EV.PLATE_START, { id: me.id });
  }

  // ---- ADS
  const boltBlocks = Wd && Wd.mode === 'bolt' && vs.boltT >= 0 && vs.boltT > 0.12 && vs.boltT < vs.boltDur * 0.85;
  const reloadBlocks = vs.reload && Wd && Wd.scope;
  const wantAds = able && Wd && (input.down('ads') || forceAds) && !sprinting && !switching && !vs.plate && !vs.nade && !boltBlocks && !reloadBlocks;
  if (Wd) {
    const rate = 1 / Math.max(0.05, Wd.ads);
    L.ads = clamp(L.ads + (wantAds ? rate : -rate / TUNE.adsOutFactor) * dt, 0, 1);
    L.adsFov = baseVFov() * Wd.adsFovMult;
  } else { L.ads = Math.max(0, L.ads - dt * 6); L.adsFov = 0; }
  const adsActive = L.ads >= 0.5;
  if (adsActive !== lastAdsActive) { lastAdsActive = adsActive; emit(EV.ADS, { active: adsActive }); }
  L.scoped = !!(Wd && Wd.scope && L.ads > 0.9);

  // ---- breath and scope sway
  const holdHeld = L.scoped && input.down('sprint');
  const holding = holdHeld && !breathTired && L.breath > 0;
  if (holding !== vs.holdingBreath) { vs.holdingBreath = holding; emit(AEV.SWAY_BREATH, { id: me.id, hold: holding }); }
  const hb = Wd && Wd.holdBreath ? Wd.holdBreath : 4;
  if (holding) { L.breath = Math.max(0, L.breath - dt / hb); if (L.breath <= 0) breathTired = true; }
  else { L.breath = Math.min(1, L.breath + dt / (hb * TUNE.breathRefill)); if (L.breath >= 1) breathTired = false; }
  swayT += dt;
  if (L.scoped && Wd.scopeSwayDeg) {
    const S = TUNE.scopeSway;
    let A = Wd.scopeSwayDeg * (holding ? S.hold : breathTired ? S.tired : 1);
    if (hasFlag(me, FLAG.CROUCH)) A *= S.crouch;
    A *= 1 + (S.move - 1) * clamp((me.speed || 0) / PLAYER.walkSpeed, 0, 1);
    const tx = A * (Math.sin(swayT * S.f1) + 0.3 * Math.sin(swayT * S.f2 + 1.3));
    const ty = A * 0.7 * (Math.sin(swayT * S.f3 + 0.6) + 0.28 * Math.sin(swayT * S.f4 + 2.1));
    vs.sway.yaw = damp(vs.sway.yaw, tx, 10, dt);
    vs.sway.pitch = damp(vs.sway.pitch, ty, 10, dt);
  } else {
    vs.sway.yaw = damp(vs.sway.yaw, 0, 8, dt);
    vs.sway.pitch = damp(vs.sway.pitch, 0, 8, dt);
  }

  // ---- spread
  if (Wd) {
    const S = Wd.spread;
    bloom = Math.max(0, bloom - S.recover * dt);
    const move = clamp((me.speed || 0) / PLAYER.sprintSpeed, 0, 1);
    let hip = S.hip + S.move * move + bloom;
    if (hasFlag(me, FLAG.CROUCH)) hip *= TUNE.crouchSpread;
    if (hasFlag(me, FLAG.AIRBORNE) || !ground) hip += S.air;
    hip = Math.min(hip, S.max + (hasFlag(me, FLAG.AIRBORNE) ? S.air : 0));
    const a = L.ads * L.ads * (3 - 2 * L.ads);
    L.spread = hip + (S.ads + S.move * move * 0.15 - hip) * a;
  } else L.spread = 0;

  // ---- fire
  if (vs.sinceShot > TUNE.burstReset) shotIndex = 0;
  const firePressed = input.pressed('fire') || (forceFire && !lastForceFire);
  const fireDown = input.down('fire') || forceFire;
  lastForceFire = forceFire;
  if (Wd && Wd.mode !== 'auto' && firePressed) semiBuf = TUNE.semiBuffer;
  if (!fireDown) fireCd = Math.max(fireCd, 0);
  fireCd = Math.max(fireCd, -0.05);
  const blockedBySprint = sprinting || vs.sinceSprint < (Wd ? Wd.sprintToFire : 0);
  // reload cancel by firing while rounds remain and the magazine is still in
  if (vs.reload && firePressed && slot && slot.mag > 0 && vs.reload.u < W_(vs.reload.weapon).reloadCues.magout) {
    emit(EV.WEAPON_RELOAD, { id: me.id, weapon: vs.reload.weapon, phase: 'cancel', empty: vs.reload.empty });
    vs.reload = null;
  }
  const canFire = able && Wd && slot && !blockedBySprint && !vs.reload && !vs.plate && !vs.nade && !switching && vs.boltT < 0;
  if (canFire) {
    const trigger = Wd.mode === 'auto' ? fireDown : semiBuf > 0;
    if (trigger && slot.mag <= 0) {
      if (firePressed) {
        emit(EV.WEAPON_DRY, { id: me.id, weapon: vs.drawn });
        if (inventory.ammo(Wd.ammo) > 0) startReload(me, slot, Wd);
      }
      semiBuf = 0;
    } else if (trigger) {
      let n = 0;
      while (fireCd <= 0 && slot.mag > 0 && n < TUNE.maxShotsPerFrame) {
        shoot(me, slot, Wd);
        fireCd += 60 / Wd.rpm;
        n++;
        if (Wd.mode !== 'auto') { semiBuf = 0; break; }
      }
    }
  } else if (firePressed && able && Wd && slot && slot.mag <= 0 && !vs.reload && !switching && !vs.plate && !vs.nade) {
    emit(EV.WEAPON_DRY, { id: me.id, weapon: vs.drawn });
  }

  // ---- reload input and auto reload
  let autoReload = false;
  if (autoReloadT >= 0 && !fireDown) { autoReloadT -= dt; if (autoReloadT <= 0) { autoReload = true; autoReloadT = -1; } }
  const wantReload = input.pressed('reload') || autoReload;
  if (able && Wd && slot && wantReload && !vs.reload && !vs.plate && !vs.nade && !switching && vs.boltT < 0) startReload(me, slot, Wd);

  // ---- action progress and flags
  if (vs.reload) { L.action = 'reload'; L.actionT = vs.reload.u; }
  else if (vs.plate) { L.action = 'plate'; L.actionT = clamp(vs.plate.t / PLAYER.armor.insertTime, 0, 1); }
  else if (vs.nade) { L.action = 'throw'; L.actionT = vs.nade.phase === 'cook' ? clamp(vs.nade.cook / F.fuse, 0, 1) : 1; }
  else if (vs.switchPhase !== 'none') { L.action = 'switch'; L.actionT = clamp(vs.switchT / Math.max(0.01, vs.switchDur), 0, 1); }
  else if (vs.boltT >= 0) { L.action = 'bolt'; L.actionT = clamp(vs.boltT / vs.boltDur, 0, 1); }
  else { L.action = null; L.actionT = 0; }
  setFlag(me, FLAG.ADS, L.ads > 0.5);
  setFlag(me, FLAG.FIRING, firingT > 0);
  setFlag(me, FLAG.RELOAD, !!vs.reload);
  setFlag(me, FLAG.PLATE, !!vs.plate);
  setFlag(me, FLAG.THROW, !!vs.nade && vs.nade.phase !== 'recover');
}
