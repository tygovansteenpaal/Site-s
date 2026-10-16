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
