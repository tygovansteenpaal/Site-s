# INTEGRATION progress log

One line per finished item: what | files | how verified.

- 2026-10-16 start: every group delivered; index.html boots to the menu in about 20 s at low with no console errors (integ/boot.cjs). main.js already had boot, frame order, intents and the contract check from the LEAD.
- match size from the brief: 10 players (alone in quick play: 1 + 9 bots), alone timer 20 s; menu copy says bots fill every empty slot | config.js MATCH, ui/menu.js | flow.cjs: roster 10, bots 9, menu>lobby>match 24 s (3.5 s bucket probe + 20 s timer)
- automation hooks window.__zf.test (info, lock, intent, skipLobby, skipTo, skipToDoors, jump, teleport, give, spawnBot, killAllBots, killSelf, stepZone, god, press, hold, look, face) + input testLock (headless browsers cannot lock the pointer) + bots.placeNear | main.js, engine/input.js, game/bots.js | flow.cjs drives a whole match with them
- hidden tab keeps simulating online (worker timer at 20 Hz, no rendering) so a backgrounded host keeps running the bots; loop.fps measured over real time and loop.frames counter | core/loop.js, main.js | mp.cjs (host tab hidden, client keeps receiving bot snapshots)
- renderer stats and adaptive resolution use the real frame interval (the loop clamps dt to 50 ms, which hid slow frames: SwiftShader read "24 fps" at 0.6 fps) | engine/renderer.js | fps.cjs
- practice pause: lock regained resumes, a dead player never pauses, pause overlay never covers the death screen; regen delay frozen while paused | main.js, ui/ui.js, combat/damage.js | dbgdeath*.cjs, flow.cjs death -> spectate
- results timer ignores a match that was left or replaced within MATCH.endDelay | main.js | code review
- results/death stats grid: second row no longer gets a stray left border | styles/base.css, styles/screens.css | f_16_results.png
- docs: ARCHITECTURE updated (10 players, 20 s, third-person default with V for first person, hidden-tab loop, UI read-only additions, bots additions, __zf.test); README.md written | ARCHITECTURE.md, README.md | read through
- 2026-10-16 resume (fresh container): flow.cjs end to end clean (loading 33% -> menu -> quick play alone 24.7 s to a 10-player match with 9 bots -> plane, jump, chute -> Harrow -> pickup -> M4 kills a bot in ADS -> zone steps -> outside the zone -> death screen -> spectate -> results -> menu -> practice win -> results -> menu), 0 console errors, 0 bus errors | (no code change) | flow.cjs, f_01..f_20 reviewed
- quick play PLAY AGAIN: results -> lobby (alone timer) -> fresh second match (new id, 10 players, alive) -> main menu offline | (no code change) | again.cjs, again_*.png
- real Trystero path (relay bridge, production code): 8 relays, alone timer -> quick match with 9 bots, main menu leaves the session; two-page local transport: same match id/seed, hidden host keeps sending bot batches (387 frames, 624 batches sent, 8/8 bots moving on the client) | (no code change) | nostr.cjs, mp.cjs
- ADS from third person handed over to the first-person view model: the camera travels to the eye and the COMBAT viewmodel's sights draw past TUNE.adsFpAt (the avatar's own hands filled the screen before); aim ray from the eye in ADS | player/camera.js, ARCHITECTURE.md 2.5, README.md | look.cjs medium/high ADS + firing shots, f_10_fight_ads.png
- loot draw cost: view-cone culling of item meshes (rebuild on a 10 deg turn or 1.5 m move), draw/LOD distance x0.6 low / x0.85 medium, no loot shadows on low, 1200-triangle cap for ammo/frag/plate near LODs (loot at Harrow: low 106-135k -> 6k tris, medium 146k -> 21k) | game/loot.js | tris.cjs, lootvis.cjs (4/12/30 m and turn-away/back counts, screenshots)
- the countryside building mesh (one 475 m merged mesh, always drawn in both passes) is cut into 150 m cells so the camera and shadow camera cull it | world/world.js | tris.cjs, menu flyover shot
- test hook face() aims from the player's eye when the camera has not caught up after a teleport | main.js | lootvis.cjs
