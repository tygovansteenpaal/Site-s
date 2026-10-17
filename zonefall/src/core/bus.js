// ZONEFALL - event bus. OWNER: LEAD. Complete; builders use it, do not edit it.
// Rules: payloads are plain objects; positions/directions are [x, y, z] number arrays (never THREE objects),
// so events can be logged, stubbed in dev harnesses and mirrored over the network unchanged.

export const EV = Object.freeze({
  // app / system
  APP_STATE: 'app:state',               // {from, to}
  LOAD_PROGRESS: 'load:progress',       // {p: 0..1, label}
  SETTINGS_CHANGED: 'settings:changed', // {key, value}
  QUALITY_CHANGED: 'quality:changed',   // {tier}
  UI_INTENT: 'ui:intent',               // {type, ...} see ARCHITECTURE.md 9.3
  TOAST: 'ui:toast',                    // {text, kind: 'info'|'warn'|'danger', ms}
  INPUT_LOCK: 'input:lock',             // {locked}
  PAUSE: 'app:pause',                   // {paused}

  // network / lobby
  NET_STATUS: 'net:status',             // {status: 'offline'|'connecting'|'online'|'error', text, relaysOpen}
  PEER_JOIN: 'net:peer-join',           // {id}
  PEER_LEAVE: 'net:peer-leave',         // {id}
  HOST_CHANGED: 'net:host',             // {hostId, epoch, self}
  NET_HELLO: 'net:hello',               // {from, data}
  NET_LOBBY: 'net:lobby',               // {from, data}
  NET_START: 'net:start',               // {from, data}
  NET_HIT: 'net:hit',                   // {from, data}
  NET_DEATH: 'net:death',               // {from, data}
  NET_PICK: 'net:pick',                 // {from, data}
  NET_DROP: 'net:drop',                 // {from, data}
  NET_NADE: 'net:nade',                 // {from, data}
  NET_SHOT: 'net:shot',                 // {from, shooterId, shot}  (decoded SHOT binary)
  NET_LEAVE: 'net:leave',               // {from, data: {mid, alive}}  a peer left our match (LEAVE MATCH, menu, tab closed)
  NET_KICK: 'net:kick',                 // {from, data: {mid}}  a peer dropped us from our match after a long silence
  NET_LINK: 'net:link',                 // {state: 'ok'|'interrupted'|'lost', reason}  our own connection during a match
  LOBBY_UPDATE: 'lobby:update',         // {lobby}  (net/lobby.getLobby() snapshot)

  // match
  MATCH_START: 'match:start',           // {id, seed, t0, roster, mode}
  MATCH_PHASE: 'match:phase',           // {phase, prev}
  MATCH_END: 'match:end',               // {winnerId, placement, stats}
  MATCH_RESULT: 'match:result',         // {winnerId, placement, stats, revised}  a death that arrived after the end re-ranked it
  ZONE_UPDATE: 'zone:update',           // {zone}  (copy of state.zone, ~2 Hz and on every state change)
  ZONE_PHASE: 'zone:phase',             // {phase, state: 'waiting'|'shrinking', next: {x, z, r}, seconds}
  PLANE_DOORS: 'plane:doors',           // {open}

  // players
  PLAYER_SPAWN: 'player:spawn',         // {id}
  PLAYER_REMOVE: 'player:remove',       // {id}
  PLAYER_JUMP: 'player:jump',           // {id}  left the plane
  PLAYER_CHUTE: 'player:chute',         // {id, open}
  PLAYER_LAND: 'player:land',           // {id, pos, speed, fall}
  FOOTSTEP: 'player:footstep',          // {id, pos, surface, sprint, crouch, local}
  PLAYER_DAMAGED: 'player:damaged',     // {id, amount, hp, armor, armorBroke, from, weapon, zone, dir, kind}
  PLAYER_KILLED: 'player:killed',       // {id, by, weapon, headshot, pos}
  PLATE_START: 'player:plate-start',    // {id}
  PLATE_DONE: 'player:plate',           // {id, armor}
  INVENTORY: 'inventory:changed',       // {inv}

  // combat
  WEAPON_FIRE: 'weapon:fire',           // {id, weapon, origin, dir, end, local, hit: {kind:'player'|'world', surface, zone, id}|null}
  WEAPON_RELOAD: 'weapon:reload',       // {id, weapon, phase: 'start'|'magout'|'magin'|'charge'|'end'|'cancel', empty}
  WEAPON_SWITCH: 'weapon:switch',       // {id, weapon}
  WEAPON_DRY: 'weapon:dry',             // {id, weapon}
  WEAPON_BOLT: 'weapon:bolt',           // {id, weapon}  bolt-action cycle after a shot
  ADS: 'weapon:ads',                    // {active}
  HIT_CONFIRMED: 'hit:confirmed',       // {target, dmg, zone, kill, armorBroke}  local shooter feedback
  BULLET_NEAR: 'shot:near',             // {pos, from}  a remote shot passed within 3 m of the local eye
  GRENADE_THROW: 'grenade:throw',       // {gid, owner, origin, vel, local}
  GRENADE_BOUNCE: 'grenade:bounce',     // {gid, pos, speed}
  GRENADE_EXPLODE: 'grenade:explode',   // {gid, owner, pos}

  // loot
  LOOT_SPAWNED: 'loot:spawned',         // {count}
  LOOT_PICKED: 'loot:picked',           // {uid, by, item}
  LOOT_NEARBY: 'loot:nearby',           // {item|null}
  CRATE_OPENED: 'loot:crate',           // {uid, by, pos}
});

const known = new Set(Object.values(EV));
const handlers = new Map(); // name -> Array<fn>
let tracing = false;
let warnUnknown = false;

/** Errors thrown inside handlers are caught, logged and collected here (tests read window.__zf.bus.errors). */
export const errors = [];

/** Subscribe. Returns an unsubscribe function. */
export function on(name, fn) {
  if (typeof fn !== 'function') throw new Error(`[bus] on('${name}') needs a function`);
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
  return () => off(name, fn);
}

/** Subscribe for one emission only. Returns an unsubscribe function. */
export function once(name, fn) {
  const wrap = (p) => { off(name, wrap); fn(p); };
  return on(name, wrap);
}

export function off(name, fn) {
  const list = handlers.get(name);
  if (!list) return;
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

/** Synchronous emit. A throwing handler does not stop the others. */
export function emit(name, payload = {}) {
  if (warnUnknown && !known.has(name)) console.warn(`[bus] emit of undeclared event '${name}' (declare it with registerEvents)`);
  if (tracing) console.debug('[bus]', name, payload);
  const list = handlers.get(name);
  if (!list || list.length === 0) return;
  for (const fn of list.slice()) {
    try { fn(payload); } catch (err) {
      errors.push({ event: name, error: String(err && err.stack || err) });
      console.error(`[bus] handler for '${name}' threw`, err);
    }
  }
}

/** Declare group-local events, e.g. const WEV = registerEvents({ CHUNK: 'world:chunk' }). */
export function registerEvents(map) {
  for (const v of Object.values(map)) known.add(v);
  return Object.freeze({ ...map });
}

/** Number of listeners (tests). */
export function listenerCount(name) { return handlers.get(name)?.length || 0; }

/** Log every emission to the console. */
export function trace(on = true) { tracing = !!on; }

/** Warn when an undeclared event name is emitted (enabled by ?debug). */
export function setStrict(on = true) { warnUnknown = !!on; }

/** Remove every listener (dev harness resets only). */
export function clear() { handlers.clear(); }
