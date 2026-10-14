// ZONEFALL dev harness helper (PLAYER group): plays the shipped audio files for the player events so footsteps per
// surface, landings, the chute and the freefall wind can be heard in dev/player.html (the game's mixer is
// engine/audio.js). Mapping follows ARCHITECTURE.md section 10. Not shipped in the game.
import { AUDIO, SURFACE, WEAPONS, audioUrl } from '../../../src/config.js';
import { on, EV } from '../../../src/core/bus.js';
import { state, localPlayer, LIFE } from '../../../src/core/state.js';

let ctx = null, master = null;
const buffers = new Map();
const loops = new Map();
const STEP = { [SURFACE.CONCRETE]: 'footstep_concrete', [SURFACE.ASPHALT]: 'footstep_concrete', [SURFACE.ROCK]: 'footstep_concrete',
  [SURFACE.METAL]: 'footstep_concrete', [SURFACE.GRASS]: 'footstep_grass', [SURFACE.WOOD]: 'footstep_wood',
  [SURFACE.DIRT]: 'footstep_gravel', [SURFACE.SAND]: 'footstep_gravel', [SURFACE.WATER]: 'footstep_gravel' };
export const log = [];

function file(name) {
  const n = AUDIO[name];
  return n ? `${name}_${Math.floor(Math.random() * n)}` : name;
}

async function buffer(f) {
  if (buffers.has(f)) return buffers.get(f);
  const p = fetch(audioUrl(f)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
  buffers.set(f, p);
  return p;
}

export function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
  }
  if (ctx.state !== 'running') ctx.resume();
}

async function play(name, { gain = 1, rate = 1 } = {}) {
  log.push(name);
  if (log.length > 40) log.shift();
  if (!ctx || ctx.state !== 'running') return;
  const b = await buffer(file(name));
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
  const g = ctx.createGain();
  g.gain.value = gain;
  s.connect(g).connect(master);
  s.start();
}

async function loop(channel, name, gain) {
  const cur = loops.get(channel);
  if (cur && cur.name === name) { cur.g.gain.setTargetAtTime(gain, ctx.currentTime, 0.2); return; }
  if (cur) { cur.g.gain.setTargetAtTime(0, ctx.currentTime, 0.2); cur.s.stop(ctx.currentTime + 1); loops.delete(channel); }
  if (!name || !ctx || ctx.state !== 'running') return;
  const b = await buffer(name);
  const s = ctx.createBufferSource();
  s.buffer = b; s.loop = true;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setTargetAtTime(gain, ctx.currentTime, 0.3);
  s.connect(g).connect(master);
  s.start();
  loops.set(channel, { name, s, g });
}

export function init() {
  on(EV.FOOTSTEP, ({ surface, sprint, crouch, local }) => play(STEP[surface] || 'footstep_grass', { gain: (local ? 0.55 : 0.3) * (sprint ? 1.3 : crouch ? 0.5 : 1) }));
  on(EV.PLAYER_LAND, ({ speed }) => play('land', { gain: Math.min(1, 0.3 + speed / 12) }));
  on(EV.PLAYER_CHUTE, ({ open }) => { if (open) play('chute_open', { gain: 0.8 }); });
  on(EV.PLAYER_DAMAGED, ({ id }) => { if (id === state.selfId) play('hit_body', { gain: 0.8 }); });
  on(EV.WEAPON_FIRE, ({ id, weapon }) => {
    const W = WEAPONS[weapon];
    if (W && W.sound) play(W.sound.shot, { gain: id === state.selfId ? 0.55 : 0.25, rate: W.sound.rate });
  });
  on(EV.WEAPON_RELOAD, ({ weapon, phase }) => {
    const W = WEAPONS[weapon];
    const pistol = W && W.sound && W.sound.mech === 'pistol';
    const map = { magout: pistol ? 'pistol_mag_out' : 'rifle_mag_out', magin: pistol ? 'pistol_mag_in' : 'rifle_mag_in', charge: 'rifle_charge' };
    if (map[phase]) play(map[phase], { gain: 0.6 });
  });
  on(EV.WEAPON_DRY, () => play('dry_fire', { gain: 0.6, rate: 1.6 }));
  on(EV.WEAPON_BOLT, () => setTimeout(() => play('bolt_cycle', { gain: 0.6 }), 250));
  on(EV.WEAPON_SWITCH, () => play('pistol_mag_in', { gain: 0.3, rate: 1.3 }));
  on(EV.PLATE_START, () => play('plate_insert', { gain: 0.6 }));
}

export function update() {
  const me = localPlayer();
  if (!me || !ctx || ctx.state !== 'running') return;
  const life = me.life;
  loop('vehicle', life === LIFE.PLANE ? 'plane_loop' : null, 0.5);
  loop('ambience', life === LIFE.FREEFALL ? 'freefall_loop' : life === LIFE.CHUTE ? 'chute_loop' : 'wind_loop', life === LIFE.GROUND ? 0.12 : 0.55);
}
