# ZONEFALL

A realistic modern-military battle royale that runs entirely in the browser. Ten operators drop onto Kessler Isle,
a 1.2 km island with a town, a farm, a walled fort, a quarry, a radio hill and a harbour. Loot weapons, ammo, armor
plates and frags, stay inside the closing zone and be the last one standing. Other people join you over a direct
peer-to-peer connection; bots fill every empty slot.

Play it at **https://tygovansteenpaal.github.io/Site-s/zonefall/**. It needs a desktop browser with WebGL 2 and
hardware acceleration, plus a mouse and keyboard (a standard gamepad also works).

## Modes

| Mode | What happens |
|---|---|
| **Quick play** | Joins a public lobby for your region. With two or more players a 45 s countdown starts (10 s at six players). If nobody else shows up within 20 s you deploy against 9 bots. Up to 10 humans per match; bots fill the rest. |
| **Private match** | Create a lobby and share its 5-character code or the invite link (`?room=CODE`). The host can press START NOW at any time; empty slots become bots. |
| **Practice vs bots** | Offline match against 9 bots. It pauses whenever you open the menu or release the mouse. |

## A match

1. **Plane.** Everyone starts in a transport plane crossing the island. The doors open once it is over land.
2. **Drop.** Press Space to jump. In freefall the mouse steers; look down and hold W to dive faster. Press Space again to open the parachute; it opens by itself at 70 m.
3. **Loot.** Walk up to an item and press F. Supply crates hold three items one tier better than the area they stand in; Fort Kessler has the best loot.
4. **Fight.** Five weapons (AK-47, M4A1, MP5, M700 with a 4x scope, 1911 pistol) plus frag grenades. Recoil follows a fixed, learnable pattern per weapon; pull down to control it. Armor takes up to three plates of 50 points; health regenerates after 5 s without damage.
5. **Zone.** The safe circle shrinks in six phases. Outside it you take damage every second, more in later phases. The minimap and the compass show the next circle.
6. **End.** The last player alive wins. After a death you can spectate the remaining players; the results screen offers Play again and Main menu.

## Controls

All keys can be rebound in Settings > Controls.

| Action | Key |
|---|---|
| Move | W A S D |
| Sprint / hold breath (scoped) | Left Shift |
| Jump, mantle, leave the plane, open or cut the parachute | Space |
| Crouch (tap to toggle, hold to crouch) / slide (while sprinting) | C or Left Ctrl |
| Fire | Left mouse |
| Aim down sights | Right mouse |
| Reload | R |
| Pick up / open crate | F |
| Insert armor plate (hold for several) | 4 |
| Frag grenade (hold to cook, release to throw) | G |
| Weapon 1 / weapon 2 / switch | 1 / 2 / mouse wheel |
| Swap shoulder | Q |
| First / third person | V |
| Free look | Left Alt |
| Full map | M |
| Scoreboard | Tab |
| Menu (releases the mouse) | Esc or P |

The camera is third person over the shoulder by default; aiming down sights switches to a first-person view through
the weapon's sights. V switches between third and first person, and the choice is remembered.

## Settings and performance

Graphics quality is picked automatically (low, medium or high) from your GPU and can be changed in Settings >
Graphics at any time, live. The renderer also lowers its resolution scale on its own when frames get slow. Settings
also cover mouse and aim sensitivity, field of view, invert Y, four volume sliders and an FPS readout. Everything is
stored in your browser only.

## How multiplayer works

There is no game server. The page is static files on GitHub Pages, and players connect to each other directly:

- **Finding each other.** The game uses [Trystero](https://github.com/dmotz/trystero) with its Nostr strategy: peers
  announce themselves on a handful of public Nostr relays under a room name (quick play: one room per region and lobby
  number; private: the lobby code, which is also the room password). The relays only carry the connection handshake.
- **Playing.** Once two browsers have exchanged their WebRTC offers, all game traffic goes over a direct WebRTC
  connection: an unreliable, unordered data channel for 20 Hz movement snapshots, bot updates and shots, and reliable
  messages for lobby state, match start, hits, deaths, loot pickups and grenades.
- **Authority.** Every player is authoritative for their own movement, health and inventory. A shooter detects a hit
  against what they see and reports it; the victim's browser checks it (fire rate, damage cap, range, both positions
  against recent history) before applying it. Remote players are drawn about 100 ms in the past and interpolated.
- **Host.** In the lobby, the player who joined first (the creator of a private lobby) is the host: it runs the
  countdown and sends the match start (a shared seed, so the zone, the plane route and the loot are identical
  everywhere). In a match, the player with the lowest peer id among those still in it simulates the bots. If that
  player leaves the match or goes silent for 6 s, the next one takes over without interrupting the match. A host keeps
  simulating while its tab is hidden. Every message carries the match it belongs to, so players who went back to the
  lobby can start the next round while others finish theirs, without the two ever mixing.
- **Dropping out.** Leaving a match early drops your loot where you stood. A player silent for 10 s is removed from the
  match ("left the match"). A browser that was asleep or lost its own connection that long shows "Disconnected" with a
  button back to the lobby instead of playing on alone.
- **Limits.** Without a TURN relay server, roughly one in ten player pairs behind strict NATs or corporate firewalls
  cannot connect directly. The lobby shows the relay count and the connection type per player. If the relays cannot
  be reached at all, the lobby says so and offers a practice match instead.

## Running it locally

No build step and no install. Serve the repository root with any static server and open the `zonefall/` folder:

```
cd Site-s
python3 -m http.server 8000
# open http://localhost:8000/zonefall/
```

three.js, three-mesh-bvh, postprocessing, ez-tree, Trystero and the fonts load from jsDelivr and Google Fonts with
pinned versions (see the import map in `index.html`).

URL switches for testing: `?quality=low|medium|high`, `?practice` (straight into practice), `?seed=N`, `?bots=N`,
`?skipplane&spawn=harrow` (start on the ground at a site), `?fastzone` (zone timings x0.1), `?room=CODE`, `?name=X`,
`?mute`, `?nopost`, `?debug`, `?net=local` (a BroadcastChannel transport between tabs of one browser instead of
the relays), and `?netsim=PING[,LOSS[,JITTER]]` to play on a simulated bad connection, for example `?netsim=150,5`
(150 ms extra round trip, 5 % loss of unreliable messages each way; reliable ones arrive late instead) or
`?netsim=250,2,40` (plus up to 40 ms jitter). It only affects the page that has it and is off without the switch.

## Code layout

```
index.html          import map, canvas, UI root, boot and fatal screens
src/main.js         boot order, frame order, menu intents, automation hooks
src/config.js       every tunable (weapons, zone, match, loot, bots, network, quality tiers)
src/core/           event bus, shared state, settings, seeded random, map data, loop
src/engine/         renderer (tiers, post, adaptive resolution), assets, input, audio
src/world/          terrain, sky, water, buildings, props, foliage, collision (BVH)
src/player/         controller, camera, avatar animation, inventory
src/combat/         weapons, ballistics, damage, grenades, effects, first-person view model
src/net/            session (Trystero), snapshot sync, lobby, wire protocol
src/game/           match flow, plane, zone, loot, bots
src/ui/ + styles/   menus, lobby, HUD, map, screens, settings
dev/*.html          standalone test benches per subsystem
```

`ARCHITECTURE.md` is the full design and module contract.

### Automation hooks

`window.__zf.test` drives a match from the browser console or a test runner: `info()`, `lock()`, `intent(type)`,
`skipLobby()`, `skipTo(seconds)`, `skipToDoors()`, `jump()`, `teleport('harrow' | [x, z])`, `give('m4a1')`,
`spawnBot(distance)`, `killAllBots()`, `killSelf()`, `stepZone()`, `god(on)`, `press(action)`, `hold(action, on)`,
`look(yaw, pitch)` and `face(target)`. Lower-level hooks per subsystem live under `window.__zf.debug`.

## Credits

ZONEFALL is an original game. All models, animations, textures, skies and sounds are third-party assets under CC0,
MIT or CC BY 3.0 licences; the full list with authors, sources and required notices is in
[`assets/LICENSES/CREDITS.md`](assets/LICENSES/CREDITS.md), and the same credits are shown in the game under
Main menu > Credits.
