// ZONEFALL - integration entry point. OWNER: LEAD (finished by the integrator). Contract: ARCHITECTURE.md 2 and 12.
// Boot order, the per-frame update order and the UI intent handlers live here and nowhere else.
// Every module is checked against CONTRACT at boot, and any exception during boot or a frame stops the loop and
// shows the fatal screen naming the module, so a missing or broken piece can never fail silently.
import * as config from './config.js';
import { DEV, MATCH, GAME_NAME, VERSION } from './config.js';
import * as bus from './core/bus.js';
import { EV } from './core/bus.js';
import { state, gfx, debug, APP, setAppState } from './core/state.js';
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
const loop = createLoop(frame);

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
    if (!locked && state.app === APP.MATCH && state.match.mode === 'practice') setPaused(true);
  });
  bus.on(EV.APP_STATE, ({ to }) => input.setEnabled(to === APP.MATCH));
  addEventListener('pagehide', () => { if (state.online) session.leave(); });
}

// ------------------------------------------------------------------------------------------ frame
function frame(dt) {
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
    renderer.render(dt);
  } catch (err) {
    loop.stop();
    fatal(err);
  }
}

addEventListener('error', (e) => { if (!window.__zf.ready) fatal(e.error || e.message); });
addEventListener('unhandledrejection', (e) => { if (!window.__zf.ready) fatal(e.reason); });

boot().catch(fatal);
