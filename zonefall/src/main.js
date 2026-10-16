// ZONEFALL - integration entry point. OWNER: LEAD (finished by the integrator). Contract: ARCHITECTURE.md 2 and 12.
// Boot order, the per-frame update order and the UI intent handlers live here and nowhere else.
// Every module is checked against CONTRACT at boot, and any exception during boot or a frame stops the loop and
// shows the fatal screen naming the module, so a missing or broken piece can never fail silently.
// window.__zf.test holds the automation hooks used by the integration suite (ARCHITECTURE.md 12.2).
import * as THREE from 'three';
import * as config from './config.js';
import { DEV, MATCH, GAME_NAME, VERSION } from './config.js';
import * as bus from './core/bus.js';
import { EV } from './core/bus.js';
import { state, gfx, debug, APP, LIFE, setAppState, localPlayer, getPlayer } from './core/state.js';
import * as settings from './core/settings.js';
import * as mapdata from './core/mapdata.js';
import { createLoop } from './core/loop.js';
import * as protocol from './net/protocol.js';

import * as renderer from './engine/renderer.js';
import * as assets from './engine/assets.js';
import * as input from './engine/input.js';
import * as audio from './engine/audio.js';
import * as world from './world/world.js';
import * as controller from './player/controller.js';
import * as camera from './player/camera.js';
import * as avatar from './player/avatar.js';
import * as inventory from './player/inventory.js';
import * as weapons from './combat/weapons.js';
import * as ballistics from './combat/ballistics.js';
import * as damage from './combat/damage.js';
import * as grenades from './combat/grenades.js';
import * as vfx from './combat/vfx.js';
import * as viewmodel from './combat/viewmodel.js';
import * as session from './net/session.js';
import * as sync from './net/sync.js';
import * as lobby from './net/lobby.js';
import * as match from './game/match.js';
import * as plane from './game/plane.js';
import * as zone from './game/zone.js';
import * as loot from './game/loot.js';
import * as bots from './game/bots.js';
import * as ui from './ui/ui.js';

// ------------------------------------------------------------------------------------------ contract check
// key: [module namespace, file, owner group, required function exports]
const CONTRACT = {
  renderer: [renderer, 'engine/renderer.js', 'WORLD', ['init', 'detectTier', 'applyQuality', 'getQuality', 'setOverlay', 'render', 'compile', 'stats', 'setExposure']],
  assets: [assets, 'engine/assets.js', 'WORLD', ['loadCore', 'model', 'cloneModel', 'clips', 'texture', 'pbr', 'sky', 'loader']],
  world: [world, 'world/world.js', 'WORLD', ['build', 'update', 'getHeight', 'getGround', 'getSurface', 'isWater', 'raycast', 'collideCapsule', 'lineOfSight', 'getLootSpawns', 'getNavHints', 'getMapImage', 'getSunDirection', 'setCrateOpen']],
  input: [input, 'engine/input.js', 'PLAYER', ['init', 'update', 'down', 'pressed', 'released', 'mouse', 'wheel', 'lock', 'unlock', 'isLocked', 'setEnabled', 'bindings']],
  controller: [controller, 'player/controller.js', 'PLAYER', ['init', 'spawn', 'update', 'jumpFromPlane', 'applyImpulse', 'teleport', 'getEye']],
  camera: [camera, 'player/camera.js', 'PLAYER', ['init', 'look', 'update', 'addRecoil', 'addShake', 'getAimRay', 'setSpectate', 'cycleSpectate']],
  avatar: [avatar, 'player/avatar.js', 'PLAYER', ['init', 'update', 'get', 'getMuzzleWorld', 'setLocalVisible']],
  inventory: [inventory, 'player/inventory.js', 'PLAYER', ['reset', 'get', 'active', 'select', 'cycle', 'canTake', 'add', 'revert', 'ammo', 'takeAmmo', 'usePlate', 'useFrag', 'dropAll']],
  weapons: [weapons, 'combat/weapons.js', 'COMBAT', ['init', 'update', 'cancelActions', 'isBusy']],
  ballistics: [ballistics, 'combat/ballistics.js', 'COMBAT', ['init', 'fire', 'hitscan', 'hitboxes', 'rayPlayers']],
  damage: [damage, 'combat/damage.js', 'COMBAT', ['init', 'damageAt', 'dealHit', 'applyToSelf', 'applyToEntity', 'kill', 'explosionAt', 'regen', 'update', 'validateHit']],
  grenades: [grenades, 'combat/grenades.js', 'COMBAT', ['init', 'throwLocal', 'spawn', 'update', 'count']],
  vfx: [vfx, 'combat/vfx.js', 'COMBAT', ['init', 'update', 'muzzleFlash', 'tracer', 'impact', 'blood', 'explosion', 'dust']],
  viewmodel: [viewmodel, 'combat/viewmodel.js', 'COMBAT', ['init', 'update', 'kick', 'getMuzzle', 'setVisible']],
  audio: [audio, 'engine/audio.js', 'COMBAT', ['init', 'unlock', 'isUnlocked', 'loadAll', 'play', 'playAt', 'gunshot', 'footstep', 'impact', 'explosion', 'ui', 'loop', 'setListener', 'update']],
  session: [session, 'net/session.js', 'NET', ['connect', 'leave', 'online', 'selfId', 'peers', 'hostId', 'isHost', 'epoch', 'send', 'sendBinary', 'setBinaryHandler', 'setStale', 'ping', 'rtt', 'diagnostics']],
  sync: [sync, 'net/sync.js', 'NET', ['init', 'update', 'sendShot', 'clockOffset', 'toLocalTime', 'selfPoseAt', 'botPoseAt', 'interpDelay']],
  lobby: [lobby, 'net/lobby.js', 'NET', ['init', 'quickPlay', 'createPrivate', 'joinPrivate', 'leave', 'requestStart', 'update', 'get']],
  match: [match, 'game/match.js', 'GAME', ['init', 'startPractice', 'hostBegin', 'beginFromNetwork', 'update', 'leave', 'planePath', 'planePosAt']],
  plane: [plane, 'game/plane.js', 'GAME', ['init', 'update', 'getTransform', 'setVisible']],
  zone: [zone, 'game/zone.js', 'GAME', ['init', 'setup', 'update', 'circleAt', 'phaseAt', 'circles', 'isInside', 'setVisible']],
  loot: [loot, 'game/loot.js', 'GAME', ['init', 'setup', 'update', 'interact', 'pickup', 'drop', 'nearest', 'all', 'clear']],
  bots: [bots, 'game/bots.js', 'GAME', ['init', 'setup', 'update', 'applyDamage', 'takeOver', 'list']],
  ui: [ui, 'ui/ui.js', 'UI', ['init', 'update', 'setLoading', 'toast', 'fatal']],
};

function checkContract() {
  const missing = [];
  for (const [, [mod, file, group, names]] of Object.entries(CONTRACT)) {
    for (const n of names) if (typeof mod[n] !== 'function') missing.push(`${group} ${file}: ${n}()`);
  }
  if (missing.length) throw new Error(`Module contract broken, missing exports:\n${missing.join('\n')}`);
}

/** Which group/file an error came from, parsed from the stack or the '[ZONEFALL] path.fn' message. */
function blame(err) {
  const text = String((err && (err.stack || err.message)) || err);
  let best = null, bestAt = Infinity;
  for (const [, [, file, group]] of Object.entries(CONTRACT)) {
    const stem = file.replace(/\.js$/, '');
    for (const needle of [`/src/${file}`, `${stem}.`]) {
      const at = text.indexOf(needle);
      if (at >= 0 && at < bestAt) { bestAt = at; best = `${group} - src/${file}`; }
    }
  }
  return best || 'INTEGRATION - src/main.js';
}

// ------------------------------------------------------------------------------------------ fatal screen
let fatalShown = false;
function fatal(err) {
  console.error('[ZONEFALL] fatal', err);
  window.__zf.fatalError = String((err && err.message) || err);
  if (fatalShown) return;
  fatalShown = true;
  const where = blame(err);
  const detail = String((err && err.message) || err);
  try { ui.fatal(where, detail); return; } catch (uiErr) { console.error('[ZONEFALL] ui.fatal failed, using fallback', uiErr); }
  const box = document.getElementById('fatal');
  box.querySelector('[data-where]').textContent = where;
  box.querySelector('[data-detail]').textContent = detail;
  box.hidden = false;
  document.getElementById('boot')?.remove();
}

// ------------------------------------------------------------------------------------------ boot
// Online play keeps simulating in a hidden tab (the host runs the bots for everyone); offline the loop just idles.
const loop = createLoop(frame, { background: () => state.online });

window.__zf = {
  name: GAME_NAME, version: VERSION, ready: false, fatalError: null,
  state, gfx, bus, config, settings, mapdata, protocol, debug, loop,
  modules: Object.fromEntries(Object.entries(CONTRACT).map(([k, [mod]]) => [k, mod])),
};

function webgl2Available() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/** Maps sub-task progress onto one 0..1 bar. */
function progressBar(weights) {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const done = {};
  let shown = 0;
  return (key, p, label) => {
    done[key] = Math.max(done[key] || 0, Math.min(1, p));
    let v = 0;
    for (const [k, w] of weights) v += (done[k] || 0) * w;
    shown = Math.max(shown, v / total);
    bus.emit(EV.LOAD_PROGRESS, { p: shown, label });
  };
}

async function boot() {
  checkContract();
  bus.setStrict(DEV.debug);
  settings.load();

  ui.init(document.getElementById('ui'));
  document.getElementById('boot')?.remove();
  setAppState(APP.LOADING);

  if (!webgl2Available()) throw new Error('This browser has no WebGL 2. ZONEFALL needs a desktop browser with hardware acceleration enabled.');
  const canvas = document.getElementById('game');
  await renderer.init(canvas, { tier: DEV.quality || settings.get('quality') });
  input.init(canvas);
  audio.init();

  const progress = progressBar([['assets', 55], ['audio', 10], ['world', 30], ['shaders', 5]]);
  await assets.loadCore((p, label) => progress('assets', p, label || 'Models and textures'));
  await audio.loadAll((p) => progress('audio', p, 'Sound'));
  await world.build({ scene: gfx.scene, quality: renderer.getQuality(), onProgress: (p, label) => progress('world', p, label || 'Island') });

  camera.init(gfx.camera);
  controller.init();
  avatar.init(gfx.scene);
  ballistics.init();
  damage.init();
  weapons.init();
  grenades.init(gfx.scene);
  vfx.init(gfx.scene);
  viewmodel.init();
  sync.init();
  lobby.init();
  plane.init(gfx.scene);
  zone.init(gfx.scene);
  loot.init(gfx.scene);
  bots.init();
  match.init();
  audio.setListener(gfx.camera);

  progress('shaders', 0.1, 'Compiling shaders');
  await renderer.compile();
  progress('shaders', 1, 'Ready');

  wireFlow();
  exposeTestHooks();
  loop.start();
  setAppState(APP.MENU);
  window.__zf.ready = true;

  if (DEV.practice) bus.emit(EV.UI_INTENT, { type: 'practice' });
  else if (DEV.room) bus.emit(EV.UI_INTENT, { type: 'join_private', code: DEV.room });
}

// ------------------------------------------------------------------------------------------ app flow and UI intents
const intents = {
  practice() {
    audio.unlock();
    match.startPractice({ bots: DEV.bots ?? undefined, seed: DEV.seed ?? undefined });
  },
  async quickplay() { audio.unlock(); setAppState(APP.LOBBY); await lobby.quickPlay(); },
  async create_private() { audio.unlock(); setAppState(APP.LOBBY); await lobby.createPrivate(); },
  async join_private({ code }) { audio.unlock(); setAppState(APP.LOBBY); await lobby.joinPrivate(code); },
  start_now() { lobby.requestStart(); },
  leave_lobby() { lobby.leave(); setAppState(APP.MENU); },
  pause() { setPaused(true); },
  resume() { input.lock(); setPaused(false); },
  spectate() { camera.setSpectate(null); },
  spectate_next() { camera.cycleSpectate(1); },
  spectate_prev() { camera.cycleSpectate(-1); },
  leave_match() { endMatchTo(state.online ? APP.LOBBY : APP.MENU); },
  play_again() {
    const mode = state.match.mode;
    endMatchTo(mode === 'practice' ? APP.MENU : APP.LOBBY);
    if (mode === 'practice') intents.practice();
  },
  main_menu() {
    endMatchTo(APP.MENU);
    if (state.online) lobby.leave();
  },
};

function setPaused(on) {
  if (state.paused === on) return;
  state.paused = on && state.app === APP.MATCH;
  bus.emit(EV.PAUSE, { paused: state.paused });
}

function endMatchTo(next) {
  if (state.app === APP.MATCH || state.app === APP.RESULTS) match.leave();
  setPaused(false);
  input.unlock();
  setAppState(next);
}

function wireFlow() {
  bus.on(EV.UI_INTENT, async (intent) => {
    const fn = intents[intent && intent.type];
    if (!fn) { console.error('[ZONEFALL] unknown UI intent', intent); return; }
    try { await fn(intent); } catch (err) {
      console.error('[ZONEFALL] intent failed', intent.type, err);
      bus.emit(EV.TOAST, { text: String(err.message || err), kind: 'danger', ms: 5000 });
      if (state.app === APP.LOBBY && !state.online) setAppState(APP.MENU);
    }
  });
  bus.on(EV.MATCH_START, () => { setPaused(false); setAppState(APP.MATCH); input.setEnabled(true); input.lock(); });
  bus.on(EV.MATCH_END, () => {
    setTimeout(() => {
      if (state.app !== APP.MATCH) return;
      input.unlock();
      setAppState(APP.RESULTS);
    }, MATCH.endDelay * 1000);
  });
  bus.on(EV.INPUT_LOCK, ({ locked }) => {
    if (state.app !== APP.MATCH || state.match.mode !== 'practice') return;
    // practice: losing the pointer pauses a living player, getting it back (canvas click, resume button) continues.
    // Once dead there is nothing to protect: the death screen and spectating keep running with a free cursor.
    const me = localPlayer();
    setPaused(!locked && !!me && me.alive && state.match.phase !== 'ended');
  });
  bus.on(EV.PLAYER_KILLED, ({ id }) => { if (id === state.selfId) setPaused(false); });
  bus.on(EV.APP_STATE, ({ to }) => input.setEnabled(to === APP.MATCH));
  addEventListener('pagehide', () => { if (state.online) session.leave(); });
}

// ------------------------------------------------------------------------------------------ frame
function frame(dt, now, hidden = false) {
  try {
    input.update();
    if (state.online) sync.update(dt);
    if (state.app === APP.LOBBY) lobby.update(dt);

    const simulate = state.app === APP.MATCH && !(state.paused && state.match.mode === 'practice');
    if (simulate) {
      camera.look(dt);       // mouse -> yaw/pitch before anything aims or moves
      match.update(dt);      // timeline, phases, win check
      plane.update(dt);
      controller.update(dt); // local movement
      weapons.update(dt);    // local firing (uses fresh aim)
      grenades.update(dt);
      bots.update(dt);       // host only
      damage.update(dt);     // regen
      zone.update(dt);
      loot.update(dt);
    }

    avatar.update(dt);
    camera.update(dt);       // final camera transform (all apps: menu flyover, match, results)
    viewmodel.update(dt);
    vfx.update(dt);
    world.update(dt, gfx.camera.position);
    audio.update(dt);
    ui.update(dt);
    if (!hidden) renderer.render(dt);   // hidden tab (online only): simulate and send, draw nothing
  } catch (err) {
    loop.stop();
    fatal(err);
  }
}

// ------------------------------------------------------------------------------------------ automation hooks
// window.__zf.test drives a whole match from a test (Playwright) or the console. Nothing in the game calls these.
const v3 = (p) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)];
const LIFE_NAME = Object.fromEntries(Object.entries(LIFE).map(([k, v]) => [v, k.toLowerCase()]));

function exposeTestHooks() {
  const need = (cond, msg) => { if (!cond) throw new Error(`[__zf.test] ${msg}`); };
  const inMatch = () => state.app === APP.MATCH && state.match.phase !== 'idle';
  const groundAt = (x, z) => world.getGround(x, z).y;
  /** Nearest open ground (no roof, wall or prop on top of the terrain) around (x, z), spiralling out to 60 m. */
  const openGround = (x, z) => {
    for (let r = 0; r <= 60; r += 3) {
      const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 3);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        const h = world.getHeight(px, pz);
        if (h > 0.5 && !world.isWater(px, pz) && Math.abs(groundAt(px, pz) - h) < 0.25) return [px, pz];
      }
    }
    return [x, z];
  };
  const T = {
    /** Snapshot of the flow state for assertions. */
    info() {
      const me = localPlayer();
      const l = lobby.get();
      return {
        app: state.app, paused: state.paused, online: state.online, host: state.isHost, locked: input.isLocked(),
        lobby: { status: l.status, text: l.text, humans: l.humans, countdown: l.countdownEndsAt == null ? null : +((l.countdownEndsAt - performance.now()) / 1000).toFixed(1) },
        match: { mode: state.match.mode, phase: state.match.phase, time: +state.match.time.toFixed(1), alive: state.match.alive, roster: state.match.roster.length,
          bots: state.match.roster.filter((r) => r.kind === 'bot').length, winner: state.match.winnerId, placement: state.match.placement, stats: { ...state.match.stats } },
        zone: { phase: state.zone.phase, state: state.zone.state, r: Math.round(state.zone.r), timeLeft: +state.zone.timeLeft.toFixed(1), outside: state.zone.outside },
        me: me ? { life: LIFE_NAME[me.life], alive: me.alive, hp: Math.round(me.hp), armor: Math.round(me.armor), pos: v3(me.pos), weapon: me.weapon,
          inv: state.local.inv ? { slots: state.local.inv.slots.map((x) => (x ? `${x.weapon}:${x.mag}` : null)), ammo: { ...state.local.inv.ammo }, plates: state.local.inv.plates, frags: state.local.inv.frags } : null,
          nearby: state.local.nearby ? state.local.nearby.label || state.local.nearby.type : null, spectating: state.local.spectating, view: state.local.mode } : null,
        screens: debug.ui && debug.ui.visible ? debug.ui.visible() : [],
        fps: loop.fps, render: renderer.stats(),
      };
    },
    /** Act as if pointer lock were granted (headless browsers cannot lock); practice unpauses with it. */
    lock(on = true) { debug.player.testLock(on); return input.isLocked(); },
    /** Send a UI intent exactly like a menu button would. */
    intent(type, extra = {}) { bus.emit(EV.UI_INTENT, { type, ...extra }); return type; },
    /** Skip the lobby timer: the host starts now (alone: bots fill the match). */
    skipLobby() { need(state.app === APP.LOBBY, 'not in a lobby'); return lobby.requestStart(); },
    /** Jump the shared match clock to t seconds (practice and host tests). */
    skipTo(t) { need(inMatch(), 'no match running'); return debug.game.skipTo(t); },
    /** Fast-forward the plane to the open doors (optionally jump out at once). */
    skipToDoors(jump = true) {
      need(inMatch(), 'no match running');
      const p = match.planePath();
      if (state.match.time < p.doorsOpenAt + 0.3) debug.game.skipTo(p.doorsOpenAt + 0.3);
      if (jump) controller.jumpFromPlane();
      return +state.match.time.toFixed(1);
    },
    /** Leave the plane now. */
    jump() { controller.jumpFromPlane(); return LIFE_NAME[localPlayer()?.life]; },
    /** Put the local player on the ground: on open ground at a site id ('harrow'), at [x, z] or [x, y, z], or below them. */
    teleport(target) {
      const me = localPlayer();
      need(me && me.alive, 'no living local player');
      let x = me.pos.x, z = me.pos.z, y = null;
      if (typeof target === 'string') { const site = mapdata.siteById(target); need(site, `unknown site '${target}'`); [x, z] = openGround(site.x, site.z); }
      else if (Array.isArray(target)) { x = target[0]; z = target[target.length - 1]; if (target.length === 3) y = target[1]; }
      if (me.life !== LIFE.GROUND) controller.spawn('ground', [x, y ?? groundAt(x, z), z]);
      else controller.teleport([x, y ?? groundAt(x, z), z]);
      me.pitch = 0;
      return v3(me.pos);
    },
    /** Give a weapon (ak47 | m4a1 | mp5 | m700 | m1911), full reserves, plates and frags. */
    give(weaponId = 'm4a1', slot = null) {
      need(localPlayer(), 'no local player');
      debug.combat.give(weaponId, slot);
      debug.combat.fillAmmo();
      return state.local.inv.slots.map((x) => (x ? x.weapon : null));
    },
    /** Bring a living bot to `dist` metres in front of the local player, facing them. Returns its id. */
    spawnBot(dist = 14, id = null) {
      const me = localPlayer();
      need(me && me.alive, 'no living local player');
      need(state.isHost || !state.online, 'only the bot authority can place bots');
      const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
      const x = me.pos.x + fx * dist, z = me.pos.z + fz * dist;
      let pickId = id;
      if (!pickId) {
        let best = Infinity;
        for (const bid of bots.list()) {
          const e = getPlayer(bid);
          if (!e || !e.alive) continue;
          const d = e.pos.distanceTo(me.pos);
          if (d < best) { best = d; pickId = bid; }
        }
      }
      need(pickId, 'no living bot left');
      const ok = bots.placeNear(pickId, x, z, Math.atan2(fx, fz));
      need(ok, `bot ${pickId} could not be placed`);
      return pickId;
    },
    /** Eliminate every bot (zone kill, no credit). Returns how many died. */
    killAllBots() { need(inMatch(), 'no match running'); return debug.game.killAllBots(); },
    /** Kill the local player (by a bot when one is alive, else the zone). */
    killSelf(byId = null) {
      const me = localPlayer();
      need(me && me.alive, 'no living local player');
      const by = byId || bots.list().find((b) => getPlayer(b)?.alive) || null;
      damage.kill(me.id, by, by ? (getPlayer(by)?.weapon || 'm4a1') : 'zone', false, null);
      return by;
    },
    /** Advance the match clock to the next zone event (wait -> shrink -> next wait). Returns the new zone state. */
    stepZone() {
      need(inMatch(), 'no match running');
      const t = state.match.time;
      const marks = [];
      for (const s of zone.timeline()) marks.push(s.waitAt, s.shrinkAt, s.endAt);
      const next = marks.find((m) => m > t + 0.05);
      need(next != null, 'the zone is already final');
      debug.game.skipTo(next + 0.05);
      zone.update(0.016);
      return { phase: state.zone.phase, state: state.zone.state, r: Math.round(state.zone.r), time: +state.match.time.toFixed(1) };
    },
    /** Invulnerability for the local player. */
    god(on = true) { return debug.combat.godMode(on); },
    /** Press (one frame) or hold a game action without a keyboard. */
    press(action) { debug.player.press(action); return action; },
    hold(action, on = true) { debug.player.hold(action, on); return action; },
    /** Turn the view by yaw/pitch radians (applied through camera.look like mouse movement). */
    look(yawRad = 0, pitchRad = 0) {
      const k = config.PLAYER.mouseRadPerPx * settings.get('sensitivity');
      debug.player.look(-yawRad / k, -pitchRad / k);
    },
    /** Aim the crosshair at a world point ([x, z] or [x, y, z]) or at another entity's chest (id). */
    face(target) {
      const me = localPlayer();
      need(me, 'no local player');
      const e = typeof target === 'string' ? getPlayer(target) : null;
      need(typeof target !== 'string' || e, 'unknown target');
      const tx = e ? e.pos.x : target[0], tz = e ? e.pos.z : target[target.length - 1];
      const ty = e ? e.pos.y + 1.2 : target.length === 3 ? target[1] : me.pos.y + 1.4;
      // the aim ray starts on the camera line (third person), which moves with the yaw: converge in a few passes
      const o = new THREE.Vector3(), d = new THREE.Vector3();
      for (let k = 0; k < 3; k++) {
        camera.getAimRay(o, d);
        const dx = tx - o.x, dy = ty - o.y, dz = tz - o.z;
        me.yaw = Math.atan2(-dx, -dz);
        me.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      return [+me.yaw.toFixed(3), +me.pitch.toFixed(3)];
    },
  };
  window.__zf.test = T;
}

addEventListener('error', (e) => { if (!window.__zf.ready) fatal(e.error || e.message); });
addEventListener('unhandledrejection', (e) => { if (!window.__zf.ready) fatal(e.reason); });

boot().catch(fatal);
