# NET progress log

One line per finished sub-feature: what | files | how verified.

- 2026-10-14 start: net/session.js, sync.js, lobby.js were LEAD stubs (notImplemented); protocol.js complete. No earlier NET work found.
- session (Trystero lazy import, curated relays, password, protocol handshake, reliable actions + validation, negotiated unreliable channel id 42 with 'bin' fallback, rate limit, host election with roster restriction + epoch/migration, ping/RTT, ICE pair diagnostics, markDropped) | src/net/session.js | local 2-page Playwright run (scratchpad/net/local.cjs)
- local fake transport over BroadcastChannel with latency/jitter/loss simulation (?net=local) | src/net/localroom.js | same run: connect 0.25 s, unreliable channel open
- sync (PSNAP 20 Hz / 5 Hz lobby, BOTS 15 Hz from host, SHOT, clock offset, adaptive 100 ms interpolation, extrapolate <=100 ms, stale/drop, pose rings, killed latch) | src/net/sync.js | local run: delay 107 ms at 50.1 ms interval/3.4 ms jitter, start t0 wall-clock diff 0.02 ms, smooth remote motion
- lobby (quick play buckets/region, private codes, hello/lobby/countdown/START NOW, handover on host change, hostBegin) | src/net/lobby.js | local run: countdown, START NOW, both pages in match
- dev/net.html harness (tactical canvas, peers table, lobby, round trips fire/hit/frag/pick/drop/zone, link sim, 17 self-tests) + stand-in match | dev/net.html, dev/stubs/net/match.js | local run: 17/17 PASS, hit->validate->death, nade identical end point, pick conflict agreed, migration epoch 1 with bots continuing; screenshots reviewed
- real Trystero path, 2 Chromium processes via relay bridge: first peer 1.6 s, 8 relays, unreliable channel + ICE host pair, t0 diff 0.9 ms, hit/death/nade/pick ok, migration epoch 1 | session/sync/lobby + dev/net.html | scratchpad/net/nostr.cjs, nostr_A/B.png reviewed
- protocol mismatch (?netv=2) isolated: 0 peers, onJoinError "protocol mismatch 2/1" | session.js | nostr.cjs ONLYCONNECT QB=&netv=2
- forced reliable 'bin' fallback (?netnochan): all flows pass, delay 109 ms | session.js | fallback.cjs at 800x450
- quick play: C hops from live bucket 1 to 2 in 0.7 s, alone -> bots after 25 s | lobby.js | quick.cjs
- bad link sim (120 ms/60 ms jitter/10 % loss): delay adapts to 150 ms, 1/300 starved frames | sync.js | bad.cjs, bad_link.png reviewed
- harness label declutter, fixes: epoch bump when the new host is alone, lobby status after begin, host alone timer reset on takeover | dev/net.html, session.js, lobby.js | reruns
- index.html: blocked before main.js runs by COMBAT viewmodel.js syntax error (duplicate 'kick'); NET exports checked statically against main.js CONTRACT: 31/31 present
- harness empty-state caption, peer state label; final regression local.cjs: 17/17, t0 diff 0.21 ms, all round trips, migration ep 1, no console errors | dev/net.html | local.cjs, lobby2.png reviewed
- 2026-10-14 resume: regression local.cjs 17/17 + all round trips + migration ep 1; real Trystero (relay bridge, 2 processes) first peer 1.55 s, 8 relays, unreliable channel, t0 diff 0.10 ms, hit/death/nade/pick ok, host leave -> epoch 1 | no code change | local.cjs, nostr.cjs, nostr_B.png reviewed
- room capacity (max 10): seat decided by the host's authoritative 'lobby' roster (hostSaysFull) with peer-count fallback, so simultaneous joiners do not both bounce; TUNE.maxHumans test knob; start whose roster excludes self -> stays in lobby "round in progress" instead of a stuck "Deploying"; harness caption for that state; stand-in match uses lobby mode | src/net/lobby.js, dev/net.html, dev/stubs/net/match.js | full.cjs (maxHumans=2: sequential bounce, simultaneous exactly one bounce, quick play hops to bucket 2, benched player waits), local.cjs + quick.cjs rerun, full_bench_B.png reviewed
