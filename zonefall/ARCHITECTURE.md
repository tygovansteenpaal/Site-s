# ZONEFALL: architecture and module contract

ZONEFALL is a realistic modern-military battle royale that runs entirely in the browser from static GitHub Pages
(`https://tygovansteenpaal.github.io/Site-s/zonefall/`). Up to 10 humans play together over serverless WebRTC
(Trystero on Nostr relays), and bots fill the match to 16. The product name is ZONEFALL. Never use the names of
existing commercial shooters anywhere in the product, code comments or assets.

This document is the contract between six builder groups working in parallel. If code and this document disagree,
fix the code or ask the lead to change the document, never silently diverge. The executable halves of the
contract are already written and complete: `src/config.js`, `src/core/*` and `src/net/protocol.js`.

---

## 0. Rules for every builder

1. **Stay in your files.** Section 5 lists every file and its OWNER group. You may only edit files your group
   owns, plus `dev/<group>.html` and `dev/stubs/<group>/*`. `src/config.js`, `src/core/*`, `index.html` and
   `src/main.js` belong to the LEAD/integrator. If you need a new tunable, put it in a `const TUNE = {...}` at the top of
   your own module and report it in your handoff. If you need a new event, declare it in your module with
   `registerEvents({...})` (bus.js) using your group's prefix, and report it.
2. **Keep the exported API exactly.** Names, parameters and return shapes in the stubs are the contract.
   `src/main.js` checks every export at boot and refuses to start if one is missing. You may add exports, but do not
   remove or rename them.
3. **Replace every `notImplemented()`.** No stubs, TODOs, placeholder art, lorem text or dead buttons in shipped code
   paths. Everything visible must work.
4. **Plain ES modules, no build step.** Use bare imports only from the import map (section 1.2). Use named exports, not
   default exports. Use no globals except `window.__zf` (debug hooks, section 12.2).
5. **Units and conventions:** metres, seconds, radians in code; degrees only where a config key ends in `Deg` or the
   doc says so; milliseconds where a key ends in `Ms` and for every network timestamp. Y is up, north is -Z and east
   is +X. `yaw = 0` looks north (-Z), and positive yaw turns left (three.js). Use `camera.rotation.order = 'YXZ'`.
6. **Events carry plain data.** Positions and directions in events are `[x, y, z]` arrays, never THREE objects.
   Continuous values go in shared state, one-off happenings go on the bus, and commands are direct function calls.
7. **Determinism.** Anything every peer must agree on (map, loot, zone, plane path, bot roster) uses `core/rng.js`
   seeded streams, never `Math.random`.
8. **Asset URLs** always come from `assetUrl()`, `textureUrl()` or `audioUrl()` in config.js. They resolve against the
   module, so `/dev/` pages work. The site lives under a sub-path, so never use a leading `/`.
9. **Performance hygiene.** Hot paths must not allocate: reuse module-level temp vectors. Smooth with
   `damp()`, not `lerp(a, b, 0.1)`. After loading, no task may block the main thread for more than 50 ms; split heavy work
   and `await` a frame.
10. **No emojis** anywhere: code, UI, docs, commit text.
11. **Errors are loud.** Throw `Error('[GROUP/module] message')` on contract violations. `main.js` stops the loop
    and shows the fatal screen naming the module.

---

## 1. Overview

### 1.1 Stack
- three.js **0.185.1** (WebGLRenderer). Use HDRLoader, not RGBELoader, and PCFShadowMap, not PCFSoftShadowMap; both are
  deprecated on r185.
- pmndrs `postprocessing` 6.39.5 (medium and high tiers), `three-mesh-bvh` 0.9.16 for static collision, `@dgreenheck/ez-tree`
  1.1.0 for procedural trees, Trystero 0.25.4 (Nostr strategy) for networking. All of them are verified to resolve.
- Assets: `assets/` is 28 MB, all meshopt + WebP GLB, JPG textures, HDR skies and MP3 audio. Licences are in
  `assets/LICENSES/`, and `CREDITS.md` has the in-game credits text, including the required CC BY 3.0 credit.

### 1.2 Import map (identical in `index.html` and every `dev/*.html`)
```json
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/",
    "three-mesh-bvh": "https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.16/build/index.module.js",
    "trystero": "https://cdn.jsdelivr.net/npm/@trystero-p2p/nostr@0.25.4/+esm",
    "postprocessing": "https://cdn.jsdelivr.net/npm/postprocessing@6.39.5/build/index.js",
    "ez-tree": "https://cdn.jsdelivr.net/npm/@dgreenheck/ez-tree@1.1.0/build/ez-tree.es.js"
  }
}
```
`trystero` and `ez-tree` (4 MB) must be loaded with dynamic `import()` inside the function that needs them, so the
menu appears quickly and practice mode works without relays.

### 1.3 Layout
```
zonefall/
  index.html                 LEAD   import map, #game canvas, #ui root, boot + fatal overlays, loads src/main.js
  ARCHITECTURE.md            LEAD   this file
  assets/                    LEAD   characters/ weapons/ props/ textures/ hdri/ audio/ LICENSES/
  dev/<group>.html           each group: standalone harness (section 12.4)
  dev/stubs/<group>/*.js     each group: stand-ins for other groups' modules used by its harness
  src/
    main.js                  LEAD   boot, frame order, UI intents, contract check, fatal screen
    config.js                LEAD   every tunable
    core/bus.js              LEAD   event bus + EV names                       (complete)
    core/state.js            LEAD   shared state, LIFE/FLAG enums, entities     (complete)
    core/settings.js         LEAD   persisted settings                          (complete)
    core/rng.js              LEAD   seeded random streams                       (complete)
    core/util.js             LEAD   damp, angles, fov, storage, notImplemented  (complete)
    core/loop.js             LEAD   rAF loop                                    (complete)
    core/mapdata.js          LEAD   island layout: POIs, roads, forests         (complete)
    engine/renderer.js       WORLD
    engine/assets.js         WORLD
    world/world.js           WORLD  facade (the only world module others import)
    world/terrain.js water.js sky.js buildings.js props.js foliage.js collision.js   WORLD internal
    engine/input.js          PLAYER
    player/controller.js camera.js avatar.js inventory.js                           PLAYER
    combat/weapons.js ballistics.js damage.js grenades.js vfx.js viewmodel.js        COMBAT
    engine/audio.js          COMBAT
    net/protocol.js          NET    (written complete by LEAD as the wire spec)
    net/session.js sync.js lobby.js                                                  NET
    game/match.js plane.js zone.js loot.js bots.js                                   GAME
    ui/ui.js menu.js lobby.js hud.js map.js screens.js settings.js styles.css        UI
```

### 1.4 Dependency direction
`core/*` and `config.js` depend on nothing in the game. Every module may import `core/*`, `config.js`, and the
**public** modules of other groups (the files listed in section 5, never another group's internal files). Cycles between
groups are allowed as long as no module calls another at import time. Only call other modules from `init()` or later.

---

## 2. Game loop and state machine

### 2.1 App states (`state.app`, changed only through `setAppState` in main.js)
```
 boot --> loading --> menu --+--> (practice) ------------------------------+
                             |                                             v
                             +--> lobby --(host countdown / start now)--> match --(MATCH_END + 6 s)--> results
                                    ^  |                                   |                            |
                                    |  +--(leave)--> menu                  +--(leave match)--> menu/lobby |
                                    +------------------(play again: online)---------------------------+
                                                         (play again: practice -> new practice match)
```
- **loading:** the UI loading screen shows `LOAD_PROGRESS` (weights: assets 55, audio 10, world 30, shaders 5).
- **menu:** the 3D island is rendered behind the menu as a slow cinematic flyover (player/camera menu mode).
- **lobby:** the same flyover is behind the lobby UI. net/lobby runs matchmaking and the countdown.
- **match:** simulation runs (section 2.3). In practice, Escape or losing pointer lock pauses the simulation; online
  play never pauses.
- **results:** the simulation is frozen, and the scene stays as the backdrop of the results screen.

### 2.2 Match timeline (shared clock)
All peers share `state.match.time = (performance.now() - state.match.t0) / 1000`. Nothing about the timeline is sent
over the network except the start message.

| Match time | Phase (`state.match.phase`) | What happens |
|---|---|---|
| -4 s .. 0 | `plane` (pre-roll) | `start` arrives `MATCH.startLeadMs` early; players are placed in the plane, and the camera shows the plane from outside. |
| 0 | `plane` | The plane spawns `preDistance` (900 m) before the flight-line centre at 380 m altitude, flying at 55 m/s. |
| doors open | `plane` | The plane is within `doorsOpenRadius` (520 m) of the island centre: `PLANE_DOORS {open:true}`, and Space jumps. |
| forced jump | `plane` | `forceJumpAt` (420 m) past the centre: anyone still aboard is ejected. |
| all out | `live` | `MATCH_PHASE {phase:'live'}`. Freefall, then the chute, then landing (about 20 s from 380 m). |
| 60 s | `live` | Zone phase 0 waiting begins (`ZONE.startAt`). |
| ... | `live` | The zone phases in 2.4. |
| alive <= 1 | `ended` | `MATCH_END`; results 6 s later. |

The plane flight line comes from `stream(seed, 'plane')`: angle uniform in [0, 2 PI), centre uniform inside
`centerJitter` (150 m) of the origin. `match.planePath()` and `planePosAt(t)` are pure.

### 2.3 Frame order (main.js `frame(dt)`, dt clamped to 0 < dt <= 0.05 s)
```
input.update()                              edges + mouse deltas for this frame
sync.update(dt)          [online]           receive/interpolate remote entities, send snapshots
lobby.update(dt)         [app = lobby]
-- simulation [app = match and not practice-paused] --
camera.look(dt)                             mouse -> local yaw/pitch (+ recoil recovery) BEFORE anything aims
match.update(dt)                            timeline, phases, alive count, win
plane.update(dt)
controller.update(dt)                       local movement (sub-steps <= 1/60 s internally)
weapons.update(dt)                          local fire/reload/ADS/plates/grenades (uses this frame's aim)
grenades.update(dt)
bots.update(dt)          [host]
damage.update(dt)                           regen
zone.update(dt)
loot.update(dt)
-- presentation (every app state) --
avatar.update(dt)  camera.update(dt)  viewmodel.update(dt)  vfx.update(dt)
world.update(dt, camera.position)  audio.update(dt)  ui.update(dt)  renderer.render(dt)
```
The loop is a variable timestep. Systems that need stability sub-step internally: the controller and bots at 1/60 s or
less, grenades at a fixed 1/120 s.

### 2.4 Zone phases (config.ZONE)
The initial circle covers the whole island (r 860 m at the origin). Phases start at match time 60 s:

| Phase | Wait (s) | Shrink (s) | Final radius (m) | Damage/s outside |
|---|---|---|---|---|
| 0 | 70 | 60 | 400 | 2 |
| 1 | 55 | 45 | 220 | 4 |
| 2 | 45 | 40 | 115 | 7 |
| 3 | 35 | 30 | 55 | 10 |
| 4 | 30 | 25 | 22 | 14 |
| 5 | 20 | 20 | 0 | 20 |

The match lasts about 9.5 minutes at most. The centre of phase k+1 is uniform inside (r_k - r_{k+1}) around centre k,
and is retried up to 12 times until it is on land. During a shrink, the centre and radius both interpolate linearly.
Zone damage ignores armor, is applied once per second, and is self-applied: each peer damages its own player, and
the host damages bots. `?fastzone` multiplies all zone times by 0.1 for tests.

### 2.5 Local life states (`entity.life`, config enum `LIFE`)
`PLANE -> FREEFALL -> CHUTE -> GROUND -> DEAD -> (SPECTATE)`. `SPECTATE` is also the state of a peer that is in the
room but not in the match. The camera is third-person for PLANE, FREEFALL, CHUTE and the 2.5 s death cam, and first-person on
GROUND.

---

## 3. Map: Kessler Isle (`src/core/mapdata.js`)

### 3.1 Frame
The world is a 1200 x 1200 m square, with x and z in [-600, 600] and sea level at y = 0. The island has a coastline radius
of about 450 to 510 m from the origin, so the corners are open sea. Map UV is `util.worldToMap(x, z)`, with north (-Z) at the top.
`MAP.seed = 1337` is a constant: terrain, buildings, props, foliage and loot spawn **points** are identical in
every match and on every peer. Per-match variety (loot items, zone, plane, bots) comes from the match seed.

### 3.2 Terrain rules (WORLD)
- Natural land: fbm hills in `MAP.naturalHeight` (6 to 34 m). There is a beach band of `MAP.beachWidth` above the waterline,
  and the seabed falls to -12 m offshore.
- Default coastline: `r(theta) = 478 + 28 sin(3 theta + 0.9) + 14 sin(7 theta + 2.3)`, with `theta = atan2(z, x)`.
  POI discs, landmark discs and roads always win: everything inside them is land.
- Site discs: terrain is set to the site height `h` inside 0.8 r and blended smoothly to natural terrain by r.
- Greystone Quarry: a pit of radius `pitRadius` (62 m) carved from the 26 m plateau down to `pitFloor` (6 m) in terraces of about 6 m,
  with a ramp road spiralling in. The pit floor stays above sea level, so the ocean plane never shows inside it.
- Signal Hill rises to its 62 m summit with slopes walkable along road R7's switchbacks (other slopes may be too steep:
  more than 46 degrees is unwalkable).
- Southport has a straight concrete quay wall along z = 455 for x in [-20, 140], with deep water south of it and a timber pier.
- Roads are flattened across their width plus 3 m shoulders. Surfaces: ASPHALT for asphalt roads, DIRT for tracks.
- `getHeight` is analytic and cheap (bots and loot call it constantly). The rendered mesh may be coarser.
- **Verification (dev/world.html):** assert that every site disc and every road vertex has `getHeight > 1.5`, and print
  any violation.

### 3.3 Sites

| id | Name | Type | Centre (x, z) | r | h | Loot tier | Floor spawn target | Crates | Buildings |
|---|---|---|---|---|---|---|---|---|---|
| harrow | HARROW | town | (-40, 40) | 120 | 14 | 1 | 120 | 3 | 12 house, 4 shop, 1 church |
| millbrook | MILLBROOK FARM | farm | (-330, 150) | 85 | 10 | 1 | 40 | 2 | farmhouse, barn, 2 shed, 2 silo |
| kessler | FORT KESSLER | military | (250, -250) | 125 | 22 | 2 | 70 | 8 | 3 barracks, hangar, command post, 4 watchtowers, 6 container stacks; wall x 160..340, z -330..-170, gates (230,-170) and (340,-250) |
| greystone | GREYSTONE QUARRY | quarry | (320, 190) | 100 | 26 (rim) | 1 | 40 | 2 | site office, 2 shed, conveyor |
| signal | SIGNAL HILL | radio | (-250, -300) | 70 | 62 | 1 | 25 | 2 | 55 m lattice mast, equipment shed, bunker |
| southport | SOUTHPORT YARD | industrial | (60, 380) | 100 | 4 | 1 | 70 | 4 | 3 warehouse, office, 10 container stacks, 2 fuel tanks, gantry crane, pier |
| fuel | MILE 9 FUEL | fuel station | (150, 10) | 30 | 16 | 0 | 10 | 1 | canopy, shop |
| cabins | PINE CABINS | cabins | (-185, 330) | 40 | 12 | 0 | 12 | 1 | 3 cabin |
| lighthouse | CAPE LIGHT | lighthouse | (415, -30) | 28 | 18 | 0 | 8 | 1 | lighthouse, cabin |
| bunker | NORTH BUNKER | bunker | (-395, -70) | 30 | 16 | 1 | 10 | 1 | bunker |

There are also 6 roadside houses (tier 0, 4 floor spawns each), placed along roads at least 60 m from any site centre.
Roads R1 to R9 (asphalt 8 m, dirt 5 m) connect everything; their polylines are in `ROADS`. Forest discs are in `FORESTS`.

### 3.4 Building rules (WORLD)
- Storey height 3.0 m, walls 0.25 m thick. Doorways are 1.2 x 2.2 m open holes (no door leaves, so there is no door state to sync).
  Windows are 1.2 x 1.3 m openings with the sill at 0.9 m: no glass, so you can see and shoot through, and mantle through.
- Every building at a site is enterable, and every storey has a floor. Stairs are visual steps over a collision ramp
  (rise 0.18 m, tread 0.28 m). Military and industrial buildings have flat roofs reachable by stairs or a ladder ramp;
  houses have pitched roofs.
- Materials (`assets.pbr`): `red_brick_03` or `concrete_wall_008` (tinted variants) for walls, `concrete_floor_worn_001` or
  `weathered_brown_planks` for floors, `corrugated_iron` (grey, rust-red, green tints) for roofs, sheds, hangar and
  warehouses, and `green_metal_rust` for containers. UVs are in metres divided by the tile size from `ASSETS.textures`.
- Geometry is merged per site and per material. Colliders are boxes and ramps that go into the BVH.
- Outputs feed the facade: collision, loot floor points (1 to 3 per room, at least 2.5 m apart, 0.05 m above the floor),
  doorway nav hints (position and outward direction) and footprints for the map image.

### 3.5 Loot spawn rules (split between WORLD and GAME)
- **WORLD produces points** in `getLootSpawns()`: `{id, pos:[x,y,z], site, tier, kind:'floor'|'crate', indoor}`. The order
  and ids are deterministic from `MAP.seed`, with ids 0..N-1 in generation order. Floor points sit inside buildings (most of
  them) and next to cover outdoors. Counts per site follow the table in 3.3 (+-15 %), for about 430 floor points plus crates
  in total. A crate point is a crate prop (`crate_old`, lid closed) standing at the point. The tier is the site tier, or 0
  outside sites.
- **GAME assigns items** in `loot.setup(seed)` using `stream(seed, 'loot')` over the spawn list in order:
  - Floor point: an item with probability `LOOT.floorChance[tier]` (0.6/0.75/0.9). The kind is weighted by `LOOT.kinds[*].w[tier]`.
  - Weapon: weighted `LOOT.weapons[id][tier]`, `qty` = a full magazine. A weapon also spawns an ammo item of its type next to it
    (uid `s<id>a`).
  - Ammo: type weighted by `LOOT.ammoTypes` (ar 45, light 40, sniper 15), `qty = LOOT.ammoQty[type]`.
  - Plate: `qty = LOOT.plateQty[tier]`. Frag: `qty = 1`.
  - Crate: uid `k<id>`. Opening it (interact) generates `LOOT.crateItems` (3) items at tier min(tier + 1, 2) from
    `stream(seed, 'crate' + id)`, with uids `c<id>.<k>`, scattered in front of the crate. Every peer generates the same
    contents on `pick` of `k<id>`.
- Uids: `s<spawnId>`, `s<spawnId>a`, `k<spawnId>`, `c<spawnId>.<k>`, `d<owner6>.<n>` (drops; owner6 = the first 6 chars of the
  dropper id, n = that dropper's drop counter).

### 3.6 Foliage, props, water (WORLD)
- **Trees:** ez-tree variants (Pine, Oak, Aspen, Ash presets) are baked at load into InstancedMeshes, dense in `FORESTS` and sparse
  elsewhere, never on roads or site cores. Beyond `treeLodDistance` they become impostor cards. Base count: 1600 at
  foliage 1.0, scaled by `quality.foliage`. Trunks collide and block bullets; leaves do not.
- **Rocks:** deformed icosahedrons with `rocky_terrain_02`, instanced, with colliders.
- **Grass:** instanced clumps within about 50 m of the camera, density `quality.grass`, with wind in the vertex shader.
- **Props:** Poly Haven props placed per site (barriers along the Kessler wall and roads, barrels, generators,
  covered cars in Harrow and Southport, tyres, utility boxes, crates). One InstancedMesh per mesh and material, chunked,
  culled at `quality.propDistance`, each with a simple box collider.
- **Water:** an ocean plane at y = 0 with a procedural normal (no water texture ships), HDRI reflections, shore tint and foam.

---

## 4. Shared state and the event bus

### 4.1 `core/state.js` (complete)
```js
state = {
  app, selfId, name, online, isHost, hostId, paused, quality,
  match: { id, seed, mode, phase, t0, time, roster, alive, winnerId, placement, stats: {kills, damage, headshots, survived, longest} },
  zone:  { phase, state, x, z, r, nx, nz, nr, timeLeft, dps, outside },
  players: Map<id, PlayerEntity>,
  local: { ads, adsFov, scoped, spread, action, actionT, cook, breath, inv, onGround, surface, stance, altitude,
           canDeploy, inPlane, eye, aimDir, fov, mode, spectating, lastDamageAt, killer, nearby },
}
gfx = { renderer, scene, camera, canvas }   debug = {}   LIFE, FLAG, APP enums
createPlayer({id, name, kind, owner, slot}), removePlayer(id), getPlayer(id), localPlayer(), isBotId(id), botId(slot),
hasFlag(e, f), setFlag(e, f, on), aliveCount(), setAppState(to), resetMatchState(), randomId(len)
```
**PlayerEntity:** `{id, name, kind:'local'|'remote'|'bot', owner, slot, alive, life, hp, armor, pos:Vector3, vel:Vector3,
yaw, pitch, flags, weapon, kills, damage, speed, stale, lastSeen}`. Ids: humans use their Trystero peer id (a random
20-char id offline), and bots use `bot:<slot>`. `slot` (0..15) is the roster index; it picks the avatar model (even slot = soldier_a)
and camo tint.

**Single writer per field:**

| Field | Writer |
|---|---|
| state.app | main.js (`setAppState`) |
| state.selfId, online, isHost, hostId | net/session |
| state.quality | engine/renderer |
| state.paused | main.js |
| state.match.* | game/match (`stats.damage`: combat/damage) |
| state.zone | game/zone |
| local entity pos/vel/life/speed, CROUCH/SPRINT/SLIDE/AIRBORNE/MANTLE flags | player/controller |
| local entity yaw/pitch | player/camera (`look`) |
| local entity weapon, ADS/FIRING/RELOAD/THROW/PLATE flags | combat/weapons |
| local entity hp/armor/alive | combat/damage |
| remote human entities (all but kills/damage) | net/sync |
| bot entities | game/bots on the host, net/sync elsewhere (hp/armor/alive: combat/damage via bots.applyDamage on host) |
| entity kills/damage counters | game/match (from events) |
| state.local.ads/adsFov/scoped/spread/action/actionT/cook/breath | combat/weapons |
| state.local.inv | player/inventory |
| state.local.onGround/surface/stance/altitude/canDeploy/inPlane | player/controller |
| state.local.eye/aimDir/fov/mode/spectating | player/camera |
| state.local.lastDamageAt/killer | combat/damage |
| state.local.nearby | game/loot |

### 4.2 `core/bus.js` (complete)
`on(name, fn) -> off`, `once`, `off`, `emit(name, payload)`, `registerEvents(map)`, `trace(on)`, `setStrict(on)`,
`listenerCount`, `clear`, `errors`. Handlers run synchronously; a throwing handler is logged and collected in `errors`
and does not stop the other handlers.

| Event (EV.*) | Payload | Emitted by | Main consumers |
|---|---|---|---|
| APP_STATE | {from, to} | main.js | ui, audio, camera, input |
| LOAD_PROGRESS | {p, label} | main.js | ui |
| SETTINGS_CHANGED | {key, value} | core/settings | renderer, audio, camera, input, ui |
| QUALITY_CHANGED | {tier} | renderer | world, avatar, vfx, ui |
| UI_INTENT | {type, ...} (9.3) | ui | main.js |
| TOAST | {text, kind, ms} | any | ui |
| INPUT_LOCK | {locked} | input | main.js, ui |
| PAUSE | {paused} | main.js | ui, audio |
| NET_STATUS | {status, text, relaysOpen} | session | ui, lobby |
| PEER_JOIN / PEER_LEAVE | {id} | session | lobby, match, sync |
| HOST_CHANGED | {hostId, epoch, self} | session | lobby, match, bots |
| NET_HELLO/LOBBY/START/HIT/DEATH/PICK/DROP/NADE | {from, data} (validated) | session | lobby / match / damage / loot / grenades |
| NET_SHOT | {from, shooterId, shot} | sync | ballistics |
| LOBBY_UPDATE | {lobby} | lobby | ui |
| MATCH_START | {id, seed, t0, roster, mode} | match | main.js, ui, audio, camera |
| MATCH_PHASE | {phase, prev} | match | ui, audio, plane |
| MATCH_END | {winnerId, placement, stats} | match | main.js, ui, audio |
| ZONE_UPDATE | {zone} | zone | ui |
| ZONE_PHASE | {phase, state, next, seconds} | zone | ui (announcement), audio |
| PLANE_DOORS | {open} | match | ui, audio |
| PLAYER_SPAWN / PLAYER_REMOVE | {id} | state.createPlayer/removePlayer | avatar |
| PLAYER_JUMP | {id} | controller | audio, ui |
| PLAYER_CHUTE | {id, open} | controller | audio, avatar |
| PLAYER_LAND | {id, pos, speed, fall} | controller | audio, vfx, camera |
| FOOTSTEP | {id, pos, surface, sprint, crouch, local} | controller (local), avatar (remote within 40 m) | audio |
| PLAYER_DAMAGED | {id, amount, hp, armor, armorBroke, from, weapon, zone, dir, kind} | damage | ui, audio, camera, avatar |
| PLAYER_KILLED | {id, by, weapon, headshot, pos} | damage (owner) and damage (on NET_DEATH), match ('left') | match, ui, audio, avatar, bots |
| PLATE_START / PLATE_DONE | {id} / {id, armor} | weapons | audio, viewmodel, ui |
| INVENTORY | {inv} | inventory | ui, weapons, viewmodel |
| WEAPON_FIRE | {id, weapon, origin, dir, end, local, hit} | ballistics | audio, vfx, avatar, ui (minimap ping), bots (hearing) |
| WEAPON_RELOAD | {id, weapon, phase, empty} | weapons | audio, viewmodel |
| WEAPON_SWITCH | {id, weapon} | weapons | audio, viewmodel, ui |
| WEAPON_DRY / WEAPON_BOLT | {id, weapon} | weapons | audio, viewmodel |
| ADS | {active} | weapons | audio, ui |
| HIT_CONFIRMED | {target, dmg, zone, kill, armorBroke} | damage | ui (hitmarker), audio |
| BULLET_NEAR | {pos, from} | ballistics | audio (whizz), camera (small shake) |
| GRENADE_THROW / BOUNCE / EXPLODE | {gid, ...} | grenades | audio, vfx, viewmodel |
| LOOT_SPAWNED / LOOT_PICKED / LOOT_NEARBY / CRATE_OPENED | see bus.js | loot | ui, audio |

---

## 5. Module contracts

Signatures below are copied from the stubs; the stubs carry fuller JSDoc. "Uses" lists the other groups' modules a
file may call.

### 5.1 WORLD: `engine/renderer.js`, `engine/assets.js`, `world/*`
**engine/renderer.js**
- `async init(canvas, {tier}) -> {renderer, scene, camera}`: fills `gfx`, applies the tier (`'auto'` calls `detectTier`, and `?quality=` overrides it).
- `detectTier() -> 'low'|'medium'|'high'`, `applyQuality(tier)` (sets `state.quality`, emits QUALITY_CHANGED),
  `getQuality() -> QUALITY entry`, `setOverlay(scene, camera)`, `render(dt)`, `async compile()`,
  `stats() -> {fps, ms, calls, tris, dpr, tier}`, `setExposure(v)`.
- Listens to SETTINGS_CHANGED `quality` (live switch). Adaptive DPR is internal.

**engine/assets.js**
- `async loadCore(onProgress)`, `model(key) -> gltf`, `cloneModel(key) -> Object3D`, `clips() -> {name: AnimationClip}`,
  `texture(id, map)`, `pbr(id, {repeat, tint, roughness, metalness, normalScale}) -> MeshStandardMaterial` (cached),
  `sky(key) -> {hdr, bg}`, `loader() -> GLTFLoader`.

**world/world.js** (facade)
- `async build({scene, quality, onProgress})`, `update(dt, viewPos)`
- `getHeight(x, z) -> number`, `getGround(x, z, fromY = Infinity) -> {y, normal:[x,y,z], surface}`, `getSurface(x, z)`,
  `isWater(x, z)`
- `raycast(origin: Vector3, dir: Vector3, maxDist) -> {distance, point, normal, surface, kind} | null`
- `collideCapsule(start: Vector3, end: Vector3, radius) -> {hit, push: Vector3, normal: Vector3}`
- `lineOfSight(a: Vector3, b: Vector3) -> boolean`
- `getLootSpawns() -> LootSpawn[]`, `getNavHints() -> {doors, covers, sites}`, `getMapImage() -> HTMLCanvasElement (1024 px)`,
  `getSunDirection() -> [x,y,z]`, `setCrateOpen(spawnId, open)`
- Internal files (`terrain, water, sky, buildings, props, foliage, collision`) are WORLD's business. Their stub APIs
  are suggestions only.
- Uses: core only.

### 5.2 PLAYER: `engine/input.js`, `player/*`
**engine/input.js:** `init(canvas)`, `update()`, `down(action)`, `pressed(action)`, `released(action)`,
`mouse() -> {dx, dy}`, `wheel() -> steps`, `lock()`, `unlock()`, `isLocked()`, `setEnabled(on)`, `bindings()`.
Emits INPUT_LOCK. Actions are the keys of `config.BINDINGS`. Clicking the canvas during a match requests pointer lock.

**player/controller.js:** `init()`, `spawn('plane'|'ground'|'spectate', pos?)`, `update(dt)`, `jumpFromPlane()`,
`applyImpulse([x,y,z])`, `teleport([x,y,z])`, `getEye(out) -> Vector3`.
Emits PLAYER_JUMP, PLAYER_CHUTE, PLAYER_LAND, FOOTSTEP. Uses world (getGround, collideCapsule, raycast for mantle),
match.planePosAt, damage.applyToSelf (fall), input.

**player/camera.js:** `init(camera)`, `look(dt)`, `update(dt)`, `addRecoil(pitchDeg, yawDeg)`,
`addShake(amount, duration)`, `getAimRay(outOrigin, outDir)`, `setSpectate(id|null)`, `cycleSpectate(dir)`.
Uses controller.getEye, avatar.get, plane.getTransform, input, settings.

**player/avatar.js:** `init(scene)`, `update(dt)`, `get(id) -> {root, muzzle, head}|null`,
`getMuzzleWorld(id, out) -> Vector3|null`, `setLocalVisible(on)`. Emits FOOTSTEP for remote avatars within 40 m.
Uses assets (soldiers, clips, weapon models), world.getGround (foot snapping).

**player/inventory.js:** `reset(loadout?) -> Inventory`, `get()`, `active() -> Slot|null`, `select(i)`, `cycle(dir)`,
`canTake(item)`, `add(item) -> {taken, dropped}`, `revert(item)`, `ammo(type)`, `takeAmmo(type, n) -> taken`, `usePlate()`,
`useFrag()`, `dropAll() -> Item[]`. Emits INVENTORY.

**Movement numbers** (config.PLAYER): walk 4.4, sprint 6.9, crouch 2.3 m/s; ADS movement x0.55 x weapon mobility;
backward x0.8, strafe x0.92. Gravity 17 m/s^2, jump 5.6 m/s (0.92 m apex). Step 0.45 m, slope limit 46 degrees.
Slide: sprinting above 5.8 m/s, then crouch gives a 9.6 m/s boost decaying over 0.85 s, with a 1.1 s cooldown. Mantle: ledges 0.5 to 1.35 m
within 0.7 m while pressing jump, over 0.45 s. Fall damage: 0 below 4.5 m, rising linearly to 100 (health only) at 16 m.
Capsule: radius 0.32, height 1.8 standing, 1.15 crouched, 0.95 sliding; eye at 1.64, 1.05 and 0.85.
Freefall: terminal 32 m/s, diving 52 m/s, glide up to 26 m/s horizontally. Space deploys above 22 m AGL, and the chute auto-deploys
at 70 m AGL. Chute: 5.5 m/s fall (3.8 braking), 11.5 to 15 m/s forward, 70 degrees/s turn, cut above 12 m, redeploy above 28 m.
Health is 100 and regenerates at 25/s after 5 s without damage. Armor: 3 plates x 50, carry up to 5, 1.15 s per plate insert.
Spawn loadout: 1911 with 8 + 24 rounds, and 2 plates carried.

### 5.3 COMBAT: `combat/*`, `engine/audio.js`
**combat/weapons.js:** `init()`, `update(dt)`, `cancelActions()`, `isBusy()`. Emits WEAPON_RELOAD, WEAPON_SWITCH,
WEAPON_DRY, WEAPON_BOLT, ADS, PLATE_START, PLATE_DONE. Uses input, inventory, camera (getAimRay, addRecoil, addShake),
viewmodel.kick, ballistics.fire, grenades.throwLocal.

**combat/ballistics.js:** `init()`, `fire(shooterId, weaponId, origin, dir, {spreadDeg, seq}) -> {end, hit}`,
`hitscan(origin, dir, range, ignoreId)`, `hitboxes(entity)`, `rayPlayers(origin, dir, range, ignoreId)`.
Emits WEAPON_FIRE, BULLET_NEAR. Uses world.raycast, damage.dealHit, sync.sendShot, avatar.getMuzzleWorld (tracer origin for
remote shots), viewmodel.getMuzzle (local tracer origin).

**combat/damage.js:** `init()`, `damageAt(weaponId, zone, distance)`, `dealHit(hit)`, `applyToSelf(amount, info)`,
`applyToEntity(entity, amount, info) -> {killed, armorBroke, dealt}`, `kill(victimId, killerId, weapon, headshot, sid)`,
`explosionAt(pos, ownerId, weapon)`, `regen(entity, dt)`, `update(dt)`, `validateHit(hit, fromPeerId)`.
Emits PLAYER_DAMAGED, PLAYER_KILLED, HIT_CONFIRMED. Uses session.send, sync.selfPoseAt/botPoseAt, bots.applyDamage,
loot.drop, inventory.dropAll, world.lineOfSight.

**combat/grenades.js:** `init(scene)`, `throwLocal(cookSeconds)`, `spawn({gid, owner, origin, vel, fuse, t})`,
`update(dt)`, `count()`. Emits GRENADE_THROW/BOUNCE/EXPLODE. Uses world.raycast, damage.explosionAt, session.send('nade'),
camera.addShake, assets (frag model).

**combat/vfx.js:** `init(scene)`, `update(dt)`, `muzzleFlash(pos, dir, scale)`, `tracer(from, to)`,
`impact(point, normal, surface)`, `blood(point, dir)`, `explosion(point)`, `dust(point, amount)`. It subscribes to its own events.

**combat/viewmodel.js:** `init()`, `update(dt)`, `kick(weaponId)`, `getMuzzle(out)`, `setVisible(on)`. Uses
renderer.setOverlay, assets, camera state, inventory.

**engine/audio.js:** `init()`, `unlock()`, `isUnlocked()`, `async loadAll(onProgress)`, `play(name, opts)`,
`playAt(name, pos, opts)`, `gunshot(weaponId, pos|null)`, `footstep(surface, pos|null, opts)`, `impact(surface, pos)`,
`explosion(pos)`, `ui(name)`, `loop(channel, name|null, volume)`, `setListener(object3d)`, `update(dt)`. It subscribes to the
bus itself (section 10).

### 5.4 Data shapes
```js
Inventory = { slots: [Slot|null, Slot|null], active: 0|1, ammo: {ar, light, sniper}, plates: int, frags: int }
Slot      = { weapon: 'ak47'|'m4a1'|'mp5'|'m700'|'m1911', mag: int }
Item      = { uid, type: 'weapon'|'ammo'|'plate'|'frag', ref: weaponId|ammoType|null, qty, pos: [x,y,z], tier }
            weapon: ref = weapon id, qty = rounds in its magazine;  ammo: ref = 'ar'|'light'|'sniper'
Crate     = { uid: 'k<id>', type: 'crate', pos, tier, spawnId, opened }
LootSpawn = { id, pos: [x,y,z], site: string|null, tier: 0|1|2, kind: 'floor'|'crate', indoor }
Hit (dealHit) = { sid, shooter, target, weapon, zone: 'head'|'body'|'limb', distance, origin: [x,y,z], targetPos: [x,y,z] }
WorldHit  = { distance, point: Vector3, normal: Vector3, surface, kind: 'terrain'|'static'|'water' }
```
Ammo types: AK-47 and M4A1 use `ar`; MP5 and 1911 use `light`; M700 uses `sniper`.

### 5.5 NET: `net/*`
**net/protocol.js** (complete): `PROTOCOL_VERSION`, `MSG`, `ACTIONS`, `encode/decodePlayerSnap`, `encode/decodeBotBatch`,
`encode/decodeShot`, `msgType`, `toArrayBuffer`, `seqNewer`, `validate.{hello, lobby, start, hit, death, pick, drop, nade, host}`,
`ZONE_CODE`, `ZONE_NAME`, `SHOT_HIT`.

**net/session.js:** `async connect({roomId, password})`, `leave()`, `online()`, `selfId()`, `peers()`, `hostId()`,
`isHost()`, `epoch()`, `send(action, data, target?)`, `sendBinary(buf, target?)`, `setBinaryHandler(fn)`,
`setStale(peerId, stale)`, `async ping(peerId)`, `rtt(peerId)`, `diagnostics()`. Emits NET_STATUS, PEER_JOIN/LEAVE,
HOST_CHANGED and NET_* per action.

**net/sync.js:** `init()`, `update(dt)`, `sendShot(shot)`, `clockOffset(peerId)`, `toLocalTime(peerId, t)`,
`selfPoseAt(tMs)`, `botPoseAt(botId, tMs)`, `interpDelay()`. Emits NET_SHOT.

**net/lobby.js:** `init()`, `async quickPlay()`, `async createPrivate() -> code`, `async joinPrivate(code)`, `leave()`,
`requestStart()`, `update(dt)`, `get() -> Lobby`. Emits LOBBY_UPDATE, TOAST. Calls match.hostBegin at countdown zero.

Every module checks `state.online` before sending; offline (practice) means no network calls at all.

### 5.6 GAME: `game/*`
**game/match.js:** `init()` (subscribes to NET_START, PLAYER_KILLED, PLAYER_DAMAGED, PEER_LEAVE, HOST_CHANGED),
`startPractice({bots, seed})`, `hostBegin(humans)`, `beginFromNetwork(start, from)`, `update(dt)`, `leave()`,
`planePath()`, `planePosAt(t, out)`. Emits MATCH_START, MATCH_PHASE, MATCH_END, PLANE_DOORS. Uses controller.spawn,
inventory.reset, zone.setup, loot.setup/clear, bots.setup/takeOver, session.send('start'), sync.clockOffset, camera.setSpectate.
A peer that leaves mid-match counts as dead: emit PLAYER_KILLED `{id, by: null, weapon: 'left'}` locally, with no drop and no credit.

**game/plane.js:** `init(scene)`, `update(dt)`, `getTransform() -> {pos, dir}`, `setVisible(on)`.

**game/zone.js:** `init(scene)`, `setup(seed)`, `update(dt)`, `circleAt(t)`, `phaseAt(t)`, `circles()`,
`isInside(x, z)`, `setVisible(on)`. Emits ZONE_UPDATE, ZONE_PHASE. Uses world.getHeight, damage.applyToSelf,
bots.applyDamage (host).

**game/loot.js:** `init(scene)`, `setup(seed)`, `update(dt)`, `interact()`, `pickup(uid, by)`, `drop(items, pos, ownerId)`,
`nearest(pos, maxDist)`, `all()`, `clear()`. Emits LOOT_SPAWNED, LOOT_PICKED, LOOT_NEARBY, CRATE_OPENED, TOAST. Uses
world.getLootSpawns/getGround/setCrateOpen, inventory, assets, session.send('pick' | 'drop'). Listens to NET_PICK and NET_DROP.

**game/bots.js:** `init()`, `setup(roster, seed)`, `update(dt)`, `applyDamage(botId, amount, info)`, `takeOver()`, `list()`.
Uses world, loot, ballistics.fire, damage.applyToEntity/kill/regen, grenades.spawn, zone, match.planePosAt.

### 5.7 UI: `ui/*`
**ui/ui.js:** `init(root)`, `update(dt)`, `setLoading(p, label)`, `toast(text, kind, ms)`, `fatal(title, detail)`.
Sub-modules: `menu.js` (`mount, show, hide, showLoading, hideLoading, showCredits`), `lobby.js` (`mount, show, hide,
render(lobby)`), `hud.js` (`mount, show, hide, update(dt)`), `map.js` (`mount, setImage, updateMinimap, setBigOpen,
isBigOpen`), `screens.js` (`mount, showDeath, showSpectate, showResults, showPause, hideAll`), `settings.js`
(`mountSettings(container)`). Only `ui/ui.js` is called by main.js; the sub-module APIs are the UI group's business.
The UI emits UI_INTENT and reads state. It may call read-only getters: `lobby.get()`, `world.getMapImage()`,
`renderer.stats()`, `session.diagnostics()`, `input.pressed/down` (map, scoreboard), `audio.ui()`, `settings.*`,
and `world.lineOfSight` for the aimed-at enemy nameplate.

---

## 6. Gun feel

### 6.1 Weapons table (config.WEAPONS; numbers are authoritative there)

| | AK-47 | M4A1 | MP5 | M700 | 1911 | Frag |
|---|---|---|---|---|---|---|
| Class / ammo | AR / ar | AR / ar | SMG / light | Sniper / sniper | Pistol / light | Lethal |
| Mode, RPM | auto 600 | auto 800 | auto 850 | bolt 50 (1.1 s bolt) | semi 400 cap | fuse 4.0 s, cookable |
| Magazine | 30 | 30 | 30 | 5 | 8 | carry 2 |
| Body dmg by range | 37 / 30 @40 m / 25 @60 m | 28 / 24 @45 / 21 @70 | 26 / 21 @15 / 16 @30 | 130 / 110 @150 | 42 / 34 @12 / 26 @25 | 160 inside 2 m, falling to 12 at 8 m |
| Head / limb mult | 1.5 / 0.9 | 1.4 / 0.9 | 1.35 / 0.9 | 2.4 / 0.9 | 1.6 / 0.9 | n/a |
| Max range | 400 m | 450 m | 200 m | 900 m | 120 m | throw 19 m/s + 3.5 up |
| Reload / empty | 2.55 / 3.1 s | 2.3 / 2.85 | 2.0 / 2.6 | 3.0 / 3.5 | 1.55 / 1.9 | throw 0.55 s |
| ADS time | 0.30 s | 0.26 | 0.20 | 0.48 | 0.16 | |
| Sprint-to-fire | 0.26 s | 0.22 | 0.16 | 0.38 | 0.12 | |
| ADS FOV mult | 0.8 | 0.8 | 0.85 | 0.25 (4x scope) | 0.9 | |
| Mobility | 0.97 | 0.98 | 1.04 | 0.92 | 1.03 | |
| GLB | weapons/stein/ak47.glb | weapons/cc0pack/m4a1.glb | weapons/stein/mp5.glb | weapons/stein/m700.glb + `Scope` from cc0pack/sniper.glb | weapons/stein/1911.glb | weapons/cc0pack/frag_grenade.glb |
| Muzzle node | SOCKET_FX_FIRE | SOCKET_FX_FIRE | SOCKET_FX_FIRE | SOCKET_FX_FIRE | SOCKET_FX_FIRE | |
| Magazine node | MAGAZINE | Magazine | MAGASINE (sic) | MAGAZINE | MAGAZINE | Pin |
| Bolt/slide node | SLIDE | Charging_Handle | BOLT | BOLT | SLIDE | |
| Sight | SOCKET_IRONSIGHT + SOCKET_ATTACH_SCOPE | rear sight `Sight_2`, line y 0.142 | SOCKET_IRONSIGHT | scope axis (mounted on SOCKET_ATTACH_SCOPE) | SOCKET_IRONSIGHT | |
| Report sample, rate | gun_rifle x0.94 | gun_rifle x1.08 | gun_pistol x1.18 | gun_sniper x1.0 + bolt_cycle | gun_pistol x0.92 | explosion |

All weapon GLBs share one convention: origin at the pistol grip, muzzle toward -Z, up +Y, in metres. They attach to
`WeaponSocket_R` with a single `add()`. `model.eye` in config is the ADS eye point in weapon space (approximately
`(0, IRONSIGHT.y, ATTACH_SCOPE.z + 0.12)` for Stein guns). Time to kill against a full 250 (100 + 150 armor) is about 0.6 s for the
ARs and SMG at close range, two body shots or one headshot for the M700, and 6 shots for the 1911.

### 6.2 Damage
`damageAt(w, zone, d)` = the step value for distance d (the last step whose `d` <= distance) x (head | limb | 1).
Armor (0 to 150) absorbs bullet and explosion damage first, and the overflow goes to health. Fall and zone damage hit health
only. Headshots damage armor too. The armor-break moment (armor reaching 0 from above 0) plays `armor_break` and shows a
distinct hitmarker.

### 6.3 Recoil and spread (deterministic per weapon, learnable)
For shot `i` (0-based) of a continuous burst:
```
k     = (ads ? 1 : hipMult)
pitch += vKick * (i == 0 ? firstShot : 1) * (1 + vRamp * min(i, rampShots) / rampShots) * k
yaw   += (hKick * sin(i * hFreq) + hBias + rand(-hJitter, hJitter)) * k        (positive = right)
```
Recoil is applied through `camera.addRecoil` and is permanent: the player pulls down to compensate. After the trigger is released,
`autoRecover x` the accumulated pitch returns at `recover` degrees/s, and the burst index resets after 0.25 s without firing.
The viewmodel kicks back `viewKickZ` metres and climbs `viewKickRotDeg`, with a spring return. Camera shake is `recoil.shake x 0.3`.
The spread cone (degrees) is `ads ? spread.ads : spread.hip + spread.move x (speed / sprintSpeed)`, plus `spread.bloom` per hip shot
(capped at `spread.max`, recovering at `spread.recover` degrees/s), plus `spread.air` when airborne. The M700 scope sways by
`scopeSwayDeg` (Lissajous), and holding sprint while scoped holds breath for `holdBreath` seconds, then sway doubles until breath refills.
Weapons cannot fire while sprinting or during sprint-to-fire, mid-reload (except empty-mag cancel), plating, switching or bolting.

### 6.4 Viewmodel (COMBAT)
The preferred approach is "true arms": a `soldier_a` clone in the overlay scene playing the upper-body `Rifle_Idle`/`Rifle_Aim`
(or pistol `Aim_Idle`) clip, with the Head bone scaled to 0 and the camera at the head. The weapon sits in `WeaponSocket_R`, so
gloved ACU arms hold the gun. ADS translates the rig so the sight line (`model.eye`) lands on the camera axis. The fallback is
the weapon alone, but it must still be lit by the environment and animated. Rifles have no reload clip, so reloads are
procedural: dip and roll the weapon, move the magazine node down and out then back at the cues, and rack the bolt/slide node.
Layers: sway from mouse delta, bob from speed, sprint pose, landing dip, switch raise and lower, plate dip, grenade arc.
The viewmodel is hidden at full scope (the UI draws the scope reticle) and outside first person.

### 6.5 Hitboxes (identical on every peer)
These are procedural from the entity pose, never from bones:
- standing: head sphere at y 1.62 (r 0.13), body capsule y 0.95..1.45 (r 0.24), limb capsule y 0.10..0.95 (r 0.17);
- crouch: heights x 0.68;
- slide: body capsule from y 0.35 lying 0.9 m along the facing, head at 0.6;
- freefall and chute: a horizontal body capsule at the entity position.
Remote entities are tested at their interpolated pose, which favours the shooter.

---

## 7. Character animation (PLAYER, avatar.js; clips from soldier_a, all in place)

| Situation | Lower body (legs, pelvis, Spine) | Upper body (mask below) |
|---|---|---|
| Idle / walk / run / sprint | `Idle`, `Walk`, `Run` (or `Jog`), `Sprint` by speed (0.3 / 3 / 6 m/s); walk backward = `Walk` timeScale -1; strafing turns the hips toward the movement by up to 60 degrees | rifle: `Rifle_Idle` (hip, sprint) / `Rifle_Aim` (ADS, firing); pistol: `Aim_Idle` / `Aim_Neutral` |
| Firing | as above | `Rifle_Shoot` / `Shoot` crossfaded in for 0.15 s per shot (remote: on WEAPON_FIRE or the FIRING flag) |
| Crouch | `Crouch_Idle`, `Crouch_Walk` | same as standing |
| Slide | `Slide_Start` then `Slide_Loop` then `Slide_Exit` (full body) | |
| Jump / fall | `Jump_Start`, `Jump_Loop`, `Jump_Land` (full body) | |
| Mantle | `Climb_1m` (full body) | |
| Reload | | `Reload` |
| Grenade / plate / pickup | | `Throw_Grenade`, `Use_Medkit`, `PickUp` |
| Hit reaction | | `Hit_Chest` / `Hit_Head` overlay, weight 0.6, 0.25 s |
| Freefall | `Swim` full body, root pitched belly-down (about -75 degrees) | |
| Chute | `Jump_Loop` full body, arms raised procedurally to the risers, canopy above | |
| Death | `Death` once, clamped on the last frame (it keeps 0.47 m root drift) | |

Upper-body track mask: `/Spine1|Spine2|Neck|Head|Clavicle|UpperArm|Forearm|Hand|Finger/` (bone names are sanitised, e.g.
`Bip01_Spine1`). Aim pitch comes from a procedural rotation of `Bip01_Spine1` and `Bip01_Spine2` (split 40/60), clamped to
+50/-40 degrees, instead of blending the extreme `Rifle_Aim_Up`/`Rifle_Aim_Down` poses. Camo tint multiplies body, helmet and
equipment materials by `TEAM_TINTS[slot % 6]`; the head is untinted. Avatars beyond 400 m are hidden. Because each avatar costs
4 to 5 draw calls, frustum culling and the `maxAnimatedAvatars` budget matter.

---

## 8. Netcode

### 8.1 Topology
This is a full WebRTC mesh through Trystero (Nostr strategy), with the 8 relays in `NET.relays`. Each human is authoritative
for their own movement, aim, HP, inventory and death. The **host** is the lexicographically lowest peer id among self and
the non-stale peers. Every peer computes it, so no election messages are needed. The host runs the lobby countdown, sends
`start`, simulates bots and owns bot HP. Host migration: when the host leaves or goes stale, the next lowest takes over
with `epoch + 1`, sends `host`, and calls `bots.takeOver()`. Peers ignore host messages that carry an older epoch.

### 8.2 Channels
- **Unreliable** (one per peer, `negotiated:true, id:42, ordered:false, maxRetransmits:0`): PSNAP, BOTS, SHOT.
  Sends are dropped while `bufferedAmount > 16384`. Until the channel is open, binary goes through the reliable `bin` action.
- **Reliable** (Trystero actions, JSON): `hello`, `lobby`, `start`, `hit`, `death`, `pick`, `drop`, `nade`, `host`, `bin`.
  Every incoming payload goes through `protocol.validate[action]`. Handshake: `onPeerHandshake` exchanges `{v: PROTOCOL_VERSION}`,
  and a mismatch rejects the peer. Peers that send more than `NET.maxMsgsPerSec` are ignored for 1 s.

### 8.3 Binary layouts (little-endian; `src/net/protocol.js` is the reference)
```
PSNAP 40 B: u8 type=1 | u8 weapon | u16 seq | f64 t | f32 x y z | f32 yaw | f32 pitch | u16 flags | u8 hp | u8 armor | u8 life | 3 B reserved
BOTS 12+24n: u8 type=2 | u8 count | u16 seq | f64 t || per bot: u8 slot | u8 weapon | u16 flags | f32 x y z | i16 yaw*1e4 | i16 pitch*1e4 | u8 hp | u8 armor | u8 life | 1 B reserved
SHOT 44 B: u8 type=3 | u8 weapon | u16 seq | f64 t | f32 origin xyz | f32 dir xyz | f32 dist | u8 surface (255 none) | u8 hitFlags (1 player, 2 head, 4 kill) | u8 botSlot (255 = sender) | 1 B reserved
```
`t` is the sender's `performance.now()` in ms. `weapon` is an index into `WEAPON_ORDER` (255 = none). `flags` uses the
`FLAG` bits, and `life` the `LIFE` values. Rates: PSNAP 20 Hz in a match and 5 Hz in the lobby (for liveness and clock offset);
BOTS 15 Hz from the host; SHOT immediately per shot.

### 8.4 Reliable payloads
| Action | Payload | Sender, when |
|---|---|---|
| hello | `{v, name, st:'lobby'\|'live', mid, hum}` | everyone, on join and every 2 s in the lobby |
| lobby | `{ep, cd: ms to start\|null, ro:[{id, name}], mode}` | host, every 1 s in the lobby |
| start | `{mid, seed, t0h, th, ro:[{id, name, kind:'h'\|'b', slot}], ep}` | host, `startLeadMs` before t0 (validate maps kind to 'human'/'bot') |
| hit | `{sid, by, tgt, w, z: 0 body\|1 head\|2 limb, dmg, d, sp:[3], tp:[3], t: match ms}` | shooter (or host for a bot shooter), broadcast |
| death | `{id, by\|null, w: weapon\|'zone'\|'fall', hs, sid\|null, pos:[3]}` | victim (host for bots), broadcast |
| pick | `{uid, t: match ms, by: botId\|null}` | picker (host for bots) |
| drop | `{items:[{uid, type, ref, qty, pos}]}` | dropper (host for bots) |
| nade | `{gid: owner:n, by, o:[3], v:[3], fuse, t: match ms}` | thrower (host for bots) |
| host | `{ep, id}` | new host after migration |

### 8.5 Authority and flows
- **Start:** non-hosts set `t0 = t0h + sync.clockOffset(host)`. The offset comes from lobby snapshots
  (`offset = min(recv - tSender)`). Without samples, they fall back to `now + (t0h - th) - rtt/2`.
- **Shot:** the shooter runs `ballistics.fire`, then `WEAPON_FIRE` locally, then a SHOT broadcast. Receivers turn SHOT into
  `WEAPON_FIRE {local:false}` (tracer from the shooter avatar's muzzle, distance-filtered report, impact fx), plus BULLET_NEAR
  if the shot passed within 3 m of their eye.
- **Hit (favour the shooter, victim confirms):**
  1. The shooter hitscans against the interpolated hitboxes it renders, then calls `damage.dealHit`.
  2. `dealHit` shows the hitmarker at once (`HIT_CONFIRMED`; armorBroke is predicted from the target's snapshot armor) and broadcasts `hit`.
  3. The victim, or the host for a bot victim, runs `validateHit`, then `applyToSelf` (or `bots.applyDamage`).
  4. HP travels in snapshots. At 0 HP the owner broadcasts `death`, and every peer emits `PLAYER_KILLED`. The kill marker and
     `kill_confirm` sound play on `PLAYER_KILLED` with `by === selfId`.
- **validateHit** (the owner enforces it, others may tally `suspicion[shooter]`):
  - shots from that shooter arrive no faster than rpm x 1.1;
  - `dmg <= damageAt(w, z, 0) + 0.01` and `d <= range`;
  - `sp` is within 2.5 m of the shooter's interpolated position, plus speed x RTT;
  - `tp` is within `1.5 m + speed x 0.35 s` of the victim's own pose at some time in `[t - 600 ms, t]` (`sync.selfPoseAt`);
  - the shooter is alive (bots: the message comes from the current host).
  A failed hit is ignored.
- **Bots:** the host simulates them and sends BOTS batches. Bot shots use the same `ballistics.fire`, and SHOT carries `botSlot`.
  Human hits on bots go to everyone; the host applies them and broadcasts the bot's `death` and `drop`.
- **Grenades:** `nade` is simulated deterministically everywhere. Each peer applies splash to itself; the host applies it to bots.
  The kill is credited to the owner with weapon `frag`.
- **Loot:** pick up optimistically and send `pick`. On a conflict, the earliest `t` wins, then the lowest id. The loser reverts and
  sees a toast. Crate opening is a `pick` of `k<id>`; the contents are deterministic.
- **Zone and fall deaths:** `death` with `by: null`, `w: 'zone'|'fall'`.
- **Leaving:** `PEER_LEAVE` or more than `NET.dropMs` stale during a match counts as death with weapon `'left'` (a local
  event only, no drop).

### 8.6 Interpolation and liveness
Remote entities render at `now - interpDelay`, where `interpDelay = clamp(2 x interval + 2 x jitter, 80, 200)` ms. Positions
lerp and yaw takes the shortest arc. When snapshots run out, the entity extrapolates for at most 100 ms, then holds. After 3 s of
silence it is `stale` (drawn as a ghost, excluded from host election). After 10 s, or on `onPeerLeave`, it is removed.
Out-of-order packets are discarded with `seqNewer`. The local player keeps 1 s of its own pose history for validation.
Background tabs throttle timers, so a backgrounded player goes stale: this is accepted.

### 8.7 Lobby and matchmaking
- **Quick play:** room `zf1-qp-<region>-<n>`. The region comes from the time zone: Europe, Africa, America (north/south), Asia,
  Australia map to eu, af, na/sa, as, oc. Each try waits `bucketProbeMs` (3.5 s); if any `hello` says `st:'live'` or the room
  has 10 or more humans, the client hops to n+1 (up to 30).
- **Private:** a 5-character code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, room `zf1-pv-<CODE>`, with `password = CODE`.
  The share link is `.../zonefall/?room=CODE`.
- **Countdown (host):** 45 s once there are 2 or more humans, 10 s once there are 6 or more. A quick-play player who is
  still alone after 25 s starts against bots. `START NOW` (host) starts immediately. Empty slots up to 16 are filled with bots
  named from `BOTS.names` (`stream(seed, 'bots')`).
- If no relay socket is open after 8 s: NET_STATUS `error` with "Can't reach matchmaking servers", and the UI offers practice.

### 8.8 Known limits (from the research)
NAT traversal is unproven without TURN (`NET.turn` is empty until an account exists), so roughly 10 to 20 % of player pairs may
fail to connect directly. `session.diagnostics()` exposes the relay count and the ICE pair type, and the lobby shows them.

---

## 9. UI

### 9.1 Look
The look is a quiet military HUD: off-white type over translucent near-black, one amber accent, and red for damage. The
typefaces are Barlow Condensed (display, labels, numbers on bars), Barlow (body) and JetBrains Mono (numerals, codes,
diagnostics). The tokens are in `src/ui/styles.css :root` (`--zf-ink`, `--zf-accent #e8b23a`, `--zf-danger #e5484d`,
`--zf-armor #5aa9e6`, `--zf-zone #ff6a3d`, ...). Display type is either very large (menu wordmark, ELIMINATED, VICTORY) or
small with letter-spacing; avoid medium sizes. There are no icon fonts and no emojis: use inline SVG glyphs only. Every
interactive element has a visible focus state, plays `audio.ui('hover')` on hover and `audio.ui('click')` on activation, and is
keyboard reachable. Motion uses `--zf-ease` and respects `prefers-reduced-motion`. The layout must work from 1280x720 up to 4K
and degrade sanely to 800x450 (test viewport).

### 9.2 HUD layout
- **Top centre:** compass strip with the heading and POI bearings, and the zone timer beneath it ("ZONE CLOSING 0:42" or
  "NEXT ZONE 1:10").
- **Top right:** minimap (150 m radius) with the alive count and kills, and the kill feed below it.
- **Bottom left:** callsign, health bar, 3 armor plate segments, and carried plates.
- **Bottom right:** weapon name, magazine / reserve, frags, and the second-slot weapon name dimmed.
- **Centre:** dynamic crosshair, hitmarkers, damage arcs, the interaction prompt ("[F] PICK UP M4A1", "[F] OPEN CRATE"), the
  action progress ring, plane/freefall/chute prompts with an altimeter, and the scope overlay.
- **Overlays:** gas tint when outside, low-health vignette, full map (M), scoreboard (Tab), death screen, spectate bar, pause.

### 9.3 UI intents (`emit(EV.UI_INTENT, {type, ...})`, handled in main.js)
`practice`, `quickplay`, `create_private`, `join_private {code}`, `start_now`, `leave_lobby`, `pause`, `resume`,
`spectate`, `spectate_next`, `spectate_prev`, `leave_match`, `play_again`, `main_menu`.
In a match, whenever the pointer is not locked the pause overlay is visible, and its primary button sends `resume`, which
requests pointer lock from the click. That covers both Escape and network-started matches, where the browser requires a gesture.

---

## 10. Audio (`assets/audio/*.mp3`, manifest `config.AUDIO`)

| Event | Sound |
|---|---|
| WEAPON_FIRE local | `gun_*` at the weapon rate, 2D, plus a synthesized sub thump (oscillator 50 to 60 Hz, 80 ms), plus `casing` 0.4 s later (rifles/pistols) |
| WEAPON_FIRE remote | `gun_*` positional, with a low-pass rising with distance and a delay of distance / 343 s, audible to about 900 m |
| WEAPON_BOLT | `bolt_cycle` |
| WEAPON_RELOAD magout / magin / charge | `rifle_mag_out` / `rifle_mag_in` / `rifle_charge` (pistols: `pistol_mag_out` / `pistol_mag_in`) |
| WEAPON_DRY | `dry_fire` (rate 1.6) |
| WEAPON_SWITCH | `pistol_mag_in` (rate 1.3, quiet) |
| ADS on | `pickup` (very quiet, rate 1.5) |
| HIT_CONFIRMED | `hitmarker`; zone head: `hitmarker_head`; armorBroke: `armor_break` |
| PLAYER_KILLED by self | `kill_confirm` |
| PLAYER_DAMAGED self | `hit_armor` if armor absorbed, else `hit_body`; `heartbeat_loop` on the 'heartbeat' channel while hp < 35 |
| BULLET_NEAR | `whizz` positional |
| Bullet impacts (WEAPON_FIRE hit.kind world) | `impact_concrete/rock/dirt/wood/metal/glass` by surface (CONCRETE, ASPHALT: concrete; ROCK: rock; GRASS, DIRT, SAND: dirt; WOOD: wood; METAL: metal; GLASS: glass) |
| FOOTSTEP | `footstep_concrete/grass/wood/gravel` by surface (CONCRETE, ASPHALT, ROCK, METAL: concrete; GRASS: grass; WOOD: wood; DIRT, SAND: gravel); sprint louder, crouch quieter |
| PLAYER_LAND | `land` |
| GRENADE_THROW / BOUNCE / EXPLODE | `grenade_pin` / `grenade_bounce` / `explosion` (positional, low-passed beyond 60 m) |
| PLATE_START / PLATE_DONE | `plate_insert` (time-aligned so the thunk lands at the plate completion) |
| LOOT_PICKED by self, CRATE_OPENED | `pickup` |
| Plane phase | `plane_loop` on 'vehicle' (inside the plane: full volume, lowpassed; outside: by distance) |
| Freefall / chute | `freefall_loop` / `chute_loop` on 'ambience'; PLAYER_CHUTE open: `chute_open` |
| Ground | `wind_loop` on 'ambience' (quiet) |
| Zone | `zone_hum_loop` on 'zone' by distance to the wall; `zone_warning` on ZONE_PHASE shrinking |
| UI | `ui_hover`, `ui_click`, `ui_confirm`, `ui_back`, `ui_error`, `ui_tick` (countdown, last 10 s), `ui_go` (match start) |

---

## 11. Config, quality tiers and budgets
`src/config.js` holds every tunable: `DEV` (URL switches), `SURFACE`, `ASSETS`, `AUDIO`, `RENDER`, `QUALITY`, `PLAYER`,
`SPAWN_LOADOUT`, `AMMO`, `WEAPON_ORDER`, `WEAPONS`, `MATCH`, `ZONE`, `LOOT`, `BOTS`, `NET`, `BINDINGS`, `ACTION_LABELS`,
`SETTINGS_DEFAULTS`, `SETTINGS_LIMITS`, `TEAM_TINTS`.

| Tier | DPR cap | Shadows | Post | View distance | Foliage / grass | Animated avatars | Budget calls / tris |
|---|---|---|---|---|---|---|---|
| low | 1.0 | 1024 map, 50 m | none (renderer ACES) | 520 m | 0.35 / 0 | 4 | 120 / 450k |
| medium | 1.25 | 2048, 90 m | SMAA + bloom + vignette + noise | 900 m | 0.7 / 0.5 | 8 | 200 / 900k |
| high | 1.5 | 4096, 140 m | + SSAO | 1300 m | 1.0 / 1.0 | 16 | 300 / 1.6M |

Auto-detect: swiftshader, llvmpipe and mobile get low; integrated GPUs get medium; discrete GPUs and Apple M get high.
Settings and `?quality=` override it. The target is 60 fps on a mid laptop GPU at medium. Adaptive DPR keeps frame time under
22 ms before anyone touches the tier. Each group checks its own cost with `renderer.stats()` in its harness.

---

## 12. Integration, debugging and testing

### 12.1 Boot sequence (main.js)
1. `checkContract()`, `settings.load()`, then `ui.init(#ui)` and the loading screen.
2. WebGL2 check, `renderer.init`, `input.init`, `audio.init`.
3. `assets.loadCore`, `audio.loadAll`, `world.build`, all reporting to one progress bar.
4. `init` of camera, controller, avatar, ballistics, damage, weapons, grenades, vfx, viewmodel, sync, lobby, plane, zone, loot,
   bots, match, then `audio.setListener(gfx.camera)`.
5. `renderer.compile()`, start the loop, `setAppState('menu')`, set `window.__zf.ready = true`. `?practice` or `?room=` then fire their intent.
Any throw during boot, or during a frame, stops the loop and shows the fatal screen naming the group and file.

### 12.2 Debug hooks
`window.__zf = {name, version, ready, fatalError, state, gfx, bus, config, settings, mapdata, protocol, debug, loop, modules}`.
`modules` holds every contract module namespace. Each group adds its test helpers under `debug.<group>`:
- WORLD: `teleportCamera`, `showColliders`;
- PLAYER: `setPos`, `giveSpeed`;
- COMBAT: `give(weaponId)`, `fillAmmo`, `godMode`;
- GAME: `skipTo(time)`, `killAllBots`, `spawnItem`;
- NET: `diag()`;
- UI: `showScreen(name, mock)`.
Tests drive the game through these hooks and `bus.emit`.

**URL switches** (config.DEV): `?quality=low|medium|high`, `?practice`, `?seed=N`, `?bots=N`, `?skipplane` (with `&spawn=<site id>`),
`?mute`, `?room=CODE`, `?name=X`, `?debug` (stats overlay, strict bus), `?fastzone`, `?nopost`.

### 12.3 Sandbox testing
- Serve the repo root with `python3 -m http.server <your assigned port> --bind 127.0.0.1` from `/home/user/Site-s` and open
  `http://127.0.0.1:<port>/zonefall/...`.
- Playwright helper (outside the shipped folder): `require('/home/user/.cache-zf/pw.cjs')`.
  - `launch({viewport, bridge})` starts Chromium with SwiftShader WebGL and routes jsdelivr and Google Fonts to the local cache
    `/home/user/.cache-zf/cdn`, downloading on first use, so the production import map is used unchanged.
  - `waitReady(page)` waits for `__zf.ready` or `__zf.fatalError`.
  - Software WebGL is slow: use 800x450 and `?quality=low` (plus `?nopost` for pure-logic tests).
- Multiplayer: `launch({bridge: true})` per simulated player (separate browsers). The browser's `wss://` goes through Node to the
  real Nostr relays (the sandbox proxy breaks browser WebSocket upgrades); the WebRTC data channels themselves are real.
  Production code is never modified for tests. A reference two-browser run is in the research folder `critic/mp/run-pw.cjs`.
- Always look at your screenshots and judge them honestly against the quality bar.

### 12.4 Dev harness pages (one per group, required)
Each page uses the same import map as `index.html` and loads `../src/...` modules. To run without the other groups'
implementations, it may **remap other groups' modules to its own stand-ins through the import map**: keys are resolved URLs,
and remapping is verified to apply transitively. Put the stand-ins in `dev/stubs/<group>/`. For example, `dev/player.html`
adds these two entries after the six standard ones:
```json
"../src/world/world.js": "./stubs/player/world.js",
"../src/combat/damage.js": "./stubs/player/damage.js"
```
A stand-in exports the same names as the real module (only the functions the harness reaches need real bodies).
| Page | Must demonstrate |
|---|---|
| dev/world.html | the full island with a free-fly camera, quality switcher, `renderer.stats()` overlay, POI teleport buttons, collider debug view, loot spawn counts per site, map image preview, terrain constraint check (3.2) |
| dev/player.html | walking/sprinting/crouch/slide/jump/mantle/fall damage on a test course (or the real world when available), the plane drop and parachute from 380 m, an avatar gallery playing every animation state, inventory operations |
| dev/combat.html | a firing range with targets at 10/25/50/100/200 m, every weapon with its viewmodel, a recoil pattern wall, damage numbers by zone and distance, grenades, all vfx, and a sound board button for every audio file and every event mapping |
| dev/net.html | two tabs or browsers in one room (`?room=`), peers, RTT, channel type, moving dummy entities interpolated, hit/death/pick/drop/nade round trips, protocol self-tests listed as PASS/FAIL |
| dev/game.html | a top-down 2D view of a whole match: zone circles over time (slider and fast-forward), loot distribution per site and tier, plane path, bots running their behaviours on a stand-in world |
| dev/ui.html | every screen and HUD state with mock data (menu, lobby, loading, HUD at full and low health, plates, kill feed, zone timer, scope, death, spectate, results, pause, settings, credits) at 1280x720 and 800x450 |

### 12.5 Definition of done (per group)
1. Every stub function is implemented, and `index.html` boots past your modules without a fatal error.
2. Your harness page works standalone, and you have looked at screenshots of it.
3. Your harness shows no console errors and no 404s.
4. Your work is within the tier budgets.
5. There are no TODOs, placeholders or emojis.
6. Your handoff note lists any `TUNE` constants and extra events you added, and anything you need from another group.
