# UI progress log

One line per finished sub-feature: what | files | how verified.

- 2026-10-14 start: all src/ui/*.js were LEAD stubs (notImplemented), styles.css only tokens; no dev/ui.html. Every other group delivered; real index.html stops at ui.init.
- 2026-10-15 resume: log + code confirm nothing beyond stubs exists; contract read (5.7, 9, 12). Plan: src/ui/{ui,dom,menu,settings,lobby,hud,minimap,map,screens}.js, CSS split into zonefall/styles/*.css imported by src/ui/styles.css (index.html links that file), dev/ui.html + dev/stubs/ui/*.
- all UI modules written (ui, dom, menu, settings, lobby, hud, minimap, map, screens) + styles/{base,menu,hud,screens}.css imported by src/ui/styles.css + dev/ui.html with dev/stubs/ui/* | not yet run
- harness boots clean; real index.html boots past ui.init: loading (survey plot + counter) -> menu over flyover -> practice plane HUD, 0 bus errors | idx.cjs, idx2.cjs screenshots reviewed
- review round 1-2 fixes: SVG hidden toggling, kill feed null text, low-health var, gas tint below widgets, prompt/killbanner spacing, title margins, compass zone/site label clash, credits grid, panel fits content | hud.js, dom.js, styles/*.css | harness shots 1280x720
- legibility pass (cluster backings, brighter dim tokens, stronger shadows) + reset specificity bug (:where) that zeroed every title margin | styles/*.css | harness sheet at 1280x720 reviewed
- real-game flows: practice death -> death screen (2.5 s) -> SPECTATE -> spectate bar on bot:1 -> killAllBots -> results -> PLAY AGAIN -> new match; pause settings FOV slider 95->104 applied live; 0 bus errors | flow.cjs
- pause overlay also opens when practice is paused while the lock is still held (was a frozen game with no overlay) | ui.js | flow.cjs
- real lobby over ?net=local, 2 pages: code shown, roster host/you/ping, START NOW only on the host page, clicked from the UI -> both pages in match with 16 roster | lobby.cjs, lobby_host.png reviewed
- lobby empty-state roster (no fake bot rows while connecting/error), bigger hitmarkers, fatal copy, pause overlay "Ready / Take control" before the first pointer lock of a match (network starts) | lobby.js, screens.js, ui.js, hud.css | harness shots, fx_sheet (arcs + body/head/kill/armor markers) reviewed
- harness: all 53 preset buttons click with 0 console errors, 0 bus errors; Enter opens settings, Esc closes; code field normalises k7-qx2o -> K7QX2 | clicks.cjs
- perf: ui.update median 0.10 ms, p95 0.40 ms with a full HUD (harness, 300 frames) | perf.cjs
- responsive: 800x450, 1280x720, 2560x1440 screenshots reviewed | shots.cjs
- final regression: index.html loading 66% -> menu -> practice at 1280x720, 0 bus errors, only the known KHR_parallel_shader_compile warning | idx.cjs idx_sheet reviewed
