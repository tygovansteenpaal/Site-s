# COMBAT progress log

One line per finished sub-feature: what | files | how verified.

- 2026-10-14 start: all combat files were still LEAD stubs (notImplemented); no earlier combat work found.
- damage.js (armor/health maths, dealHit routing + predicted HIT_CONFIRMED, kill + death drop, frag splash with LOS, regen, validateHit, NET_HIT/NET_DEATH) and ballistics.js (procedural hitboxes, ray-capsule, seeded spread, thin-cover penetration, WEAPON_FIRE/SHOT/BULLET_NEAR, NET_SHOT) written | src/combat/damage.js, src/combat/ballistics.js | pending harness test
- audio.js (buses, reverb IR, trimmed decode via OfflineAudioContext, voice limits, layered gunshots local/remote with distance delay+lowpass, footsteps, impacts, explosion synth, loops from state, full event map) written | src/engine/audio.js | pending harness test
