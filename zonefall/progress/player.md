# PLAYER group progress log

One line per finished sub-feature: what | files | how verified.

- (recovered from earlier interrupted runs) input with pointer lock, rebind map, gamepad | src/engine/input.js | Playwright inputs/inputdbg scenarios
- (recovered) controller walk/sprint/crouch/slide/jump/mantle/fall damage/plane/freefall/chute/swim | src/player/controller.js | Playwright move/moveside/mantle/fall/drop scenarios, screenshots r2-r4
- (recovered) camera TP over-shoulder, shoulder swap, collision boom, ADS through IRONSIGHT, FP, death cam, spectate, menu flyover | src/player/camera.js | Playwright views/adsall/menucam scenarios
- (recovered) avatar mixer, lower/upper layering, spine aim pitch, hit/death, chute canopy, freefall, remote snapshots | src/player/avatar.js | Playwright gallery/closeups/moveside scenarios
- (recovered) inventory | src/player/inventory.js | harness buttons
- (recovered) dev harness with course + island mode, gallery of simulated remote players | dev/player.html, dev/stubs/player/* | basic/islandbasic scenarios
- 2026-10-14 resumed: basic scenario boots clean (no console errors) | dev/player.html | node drive.cjs r5 basic
- swim pose: body submerged (lift 1.25, head-up pitch 11 deg + stroke bob) | src/player/avatar.js | swimlook/swimmeasure scenarios, screenshot r5/swimlook_local.png
- regression: views (TP idle/left shoulder/sprint FOV/boom against containers/FP/indoor/crouch), inputs (real key path, rebind, footstep surfaces, land), perf, island doorway walk | camera.js, input.js, controller.js | Playwright r5 runs, screenshots reviewed
- debug hooks debug.player.avatarTune / cameraTune (live tuning in tests); TP rifle-visibility framing experiments (shoulder 0.56-0.95, up 0.1-0.42, low-ready yaw +9..-16) showed no clear win, tuning kept | avatar.js, camera.js | r5/tpframe*.png
- index.html contract check passes for PLAYER exports; boot stops later at ui/ui.init (UI group still stubbed) | src/main.js (read only) | idx.cjs
