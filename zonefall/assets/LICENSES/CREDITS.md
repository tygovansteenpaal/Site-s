# ZONEFALL asset credits and licenses

All 3D models, textures, HDRIs and recorded sounds shipped with the game are third-party assets that may be redistributed in a public repository.
Every asset is **CC0 1.0** (public domain, no attribution required), **MIT** (the copyright and permission notice must ship with the files) or, for the gunshot recordings only, **CC BY 3.0** (attribution required, see section 6).
Credits are listed for every asset anyway.

The files in `assets/` were converted and optimized from the original downloads: FBX to GLB conversion, texture resizing and recompression, axis normalization, Biped animation retargeting, meshopt + WebP compression, and for audio: slicing, gain changes, mixing and MP3 encoding.
CC0, MIT and CC BY 3.0 all allow modification.

---

## 1. Characters: Microsoft Rocketbox Avatar Library (MIT)

| Game file | Original asset | Source |
|---|---|---|
| `characters/soldier_a.glb` | `Assets/Avatars/Professions/Military_Male_04` (mesh + ACU textures) | https://github.com/microsoft/Microsoft-Rocketbox |
| `characters/soldier_b.glb` | `Assets/Avatars/Professions/Military_Male_01` (mesh + ACU textures) | same |
| Animations `Idle`, `Idle_LookAround`, `Walk`, `Run`, `Sprint`, `Crouch_Idle` inside `soldier_a.glb` | `Assets/Animations/all_animations_max_motextr_static/m_idle_neutral_01`, `m_idle_look_around_01`, `m_crouch_idle`; `.../motextr_xy/m_walk_neutral_01`, `m_run_neutral_01`, `m_run_fast_01` (root motion removed) | same |

- **Author:** Microsoft Research and Rocketbox (original avatar team: Markus Wojcik and others; repository by Mar Gonzalez-Franco, Eyal Ofek, Anthony Steed and others)
- **License:** MIT. The full text is copied to `assets/LICENSES/Microsoft-Rocketbox-MIT-LICENSE.md` and **must stay in the repo**. The README states: *"November 2020 License Update: The library of avatars is now released under MIT License."*

> MIT License — Copyright (c) 2020 Microsoft
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND [...]

- **Citation (optional, suggested by the authors):** Gonzalez-Franco et al., "The Rocketbox library and the utility of freely available rigged avatars", *Frontiers in Virtual Reality*, 2020, DOI 10.3389/frvir.2020.561558

## 2. Animations retargeted onto the soldiers: Quaternius Universal Animation Library 1 and 2 (CC0)

The following clips in `soldier_a.glb` were retargeted from Quaternius' UE-style humanoid rig to the Rocketbox Biped rig:
`Aim_Idle, Aim_Neutral, Aim_Up, Aim_Down, Shoot, Reload, Jog, Sprint_UAL, Walk_UAL, Crouch_Walk, Crouch_Idle_UAL, Death, Hit_Chest, Hit_Head, Jump_Start, Jump_Loop, Jump_Land, Roll, Interact, PickUp, Driving, Swim, Melee, Idle_UAL` (UAL1) and `Throw_Grenade, Hit_Knockback, Slide_Start, Slide_Loop, Slide_Exit, Climb_1m, Use_Medkit, Loot` (UAL2).
`Rifle_Idle, Rifle_Aim, Rifle_Aim_Up, Rifle_Aim_Down, Rifle_Shoot` were derived from the UAL pistol clips with two-bone IK.

- **Author:** Quaternius (Tomás Laulhé), https://quaternius.com
- **Source:** https://quaternius.itch.io/universal-animation-library and https://quaternius.itch.io/universal-animation-library-2 (free "Standard" versions)
- **License:** CC0 1.0. The bundled `License.txt` (copied to `assets/LICENSES/Quaternius-UAL-License.txt`) says: *"License: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication https://creativecommons.org/publicdomain/zero/1.0/ — Models by @Quaternius"*

## 3. Weapons

### 3a. Stein Games "Classic Weapons Pack" v1.1 (CC0)
Files: `weapons/stein/ak47.glb, mp5.glb, mac10.glb, m700.glb, m14.glb, 1911.glb, tec9.glb, leveraction.glb`
- **Author:** Stein Games
- **Source:** https://stein-indie.itch.io/classic-weapons-pack (the "Classic Weapons Pack v1.1.zip" download)
- **License:** CC0 1.0. The itch page lists "Asset license: Creative Commons Zero v1.0 Universal". The bundled `license.txt` (copied to `assets/LICENSES/SteinGames-ClassicWeaponsPack-license.txt`) says:
  > "The license is CC0 1.0. You can copy, modify, distribute and perform the assets, even for commercial purposes, all without asking permission. You don't need to give credit but I would of course appreciate it. By Stein Games"
- The page also states: *"No generative AI was used [...] the weapons do not contain logos or registered trademarks."*

### 3b. 3dmodelscc0 "CC0 Guns & Explosives Pack" (CC0)
Files: `weapons/cc0pack/m4a1.glb, sniper.glb, frag_grenade.glb, smoke_grenade.glb`
- **Author:** 3dmodelscc0 (also published as "nisu" on OpenGameArt)
- **Source:** https://3dmodelscc0.itch.io/free-cc0-guns-explosives-pack ("Guns&Explosives.rar")
- **License:** CC0. The itch page says: *"Collection of 19 unique 3D firearms and explosives, all offered under a CC0 public domain license."* The same author's M4A1 is also listed as CC0 at https://opengameart.org/content/m4a1-assault-rifle

### 3c. Poly Haven firearms (CC0)
Files: `weapons/polyhaven/bolt_action_rifle_7_62.glb` and `weapons/polyhaven/service_pistol.glb`. Author: Mateusz Sadek. License: CC0, see section 5.

## 4. Props: Poly Haven (CC0)

| File | Asset page | Author(s) |
|---|---|---|
| `props/polyhaven/wooden_military_crate.glb` | https://polyhaven.com/a/wooden_military_crate | Prabhjinder Singh |
| `props/polyhaven/old_military_crate.glb` | https://polyhaven.com/a/old_military_crate | Jack Mava |
| `props/polyhaven/ammo_box.glb` | https://polyhaven.com/a/ammo_box | DanKit |
| `props/polyhaven/metal_jerrycan_green.glb` | https://polyhaven.com/a/metal_jerrycan_green | Ulan Cabanilla |
| `props/polyhaven/medical_box.glb` | https://polyhaven.com/a/medical_box | Ulan Cabanilla |
| `props/polyhaven/Barrel_01.glb` | https://polyhaven.com/a/Barrel_01 | Jorge Camacho |
| `props/polyhaven/barrel_03.glb` | https://polyhaven.com/a/barrel_03 | Serhii Khromov |
| `props/polyhaven/concrete_road_barrier_02.glb` | https://polyhaven.com/a/concrete_road_barrier_02 | Amal Kumar |
| `props/polyhaven/old_tyre.glb` | https://polyhaven.com/a/old_tyre | MP |
| `props/polyhaven/portable_generator.glb` | https://polyhaven.com/a/portable_generator | James Ray Cock |
| `props/polyhaven/covered_car.glb` | https://polyhaven.com/a/covered_car | MP |
| `props/polyhaven/wooden_crate_02.glb` | https://polyhaven.com/a/wooden_crate_02 | James Ray Cock (modeling), Jurita Burger (graphic design) |
| `props/polyhaven/cardboard_box_01.glb` | https://polyhaven.com/a/cardboard_box_01 | Rahul Chaudhary |
| `props/polyhaven/utility_box_01.glb` | https://polyhaven.com/a/utility_box_01 | James Ray Cock |
| `props/polyhaven/old_gas_mask.glb` | https://polyhaven.com/a/old_gas_mask | Michał Wiśniewski |
| `weapons/polyhaven/bolt_action_rifle_7_62.glb` | https://polyhaven.com/a/bolt_action_rifle_7_62 | Mateusz Sadek |
| `weapons/polyhaven/service_pistol.glb` | https://polyhaven.com/a/service_pistol | Mateusz Sadek |

## 5. Textures and HDRIs: Poly Haven (CC0)

| File(s) | Asset page | Author(s) |
|---|---|---|
| `hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr`, `..._bg_4k.jpg` | https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky | Greg Zaal (original), Jarod Guest (sky edits) |
| `hdri/industrial_sunset_02_puresky_1k.hdr`, `..._bg_4k.jpg` | https://polyhaven.com/a/industrial_sunset_02_puresky | Sergej Majboroda (original), Jarod Guest (sky edits) |
| `textures/sparse_grass/` | https://polyhaven.com/a/sparse_grass | Amal Kumar |
| `textures/leafy_grass/` | https://polyhaven.com/a/leafy_grass | Charlotte Baglioni |
| `textures/forrest_ground_01/` | https://polyhaven.com/a/forrest_ground_01 | Rob Tuytel |
| `textures/brown_mud_02/` | https://polyhaven.com/a/brown_mud_02 | Rob Tuytel |
| `textures/rocky_terrain_02/` | https://polyhaven.com/a/rocky_terrain_02 | Amal Kumar |
| `textures/gravelly_sand/` | https://polyhaven.com/a/gravelly_sand | Dario Barresi |
| `textures/asphalt_02/` | https://polyhaven.com/a/asphalt_02 | Rob Tuytel |
| `textures/concrete_floor_worn_001/` | https://polyhaven.com/a/concrete_floor_worn_001 | Dimitrios Savva (photography), Rico Cilliers (processing) |
| `textures/concrete_wall_008/` | https://polyhaven.com/a/concrete_wall_008 | Charlotte Baglioni (photography), Dario Barresi (processing) |
| `textures/red_brick_03/` | https://polyhaven.com/a/red_brick_03 | Rob Tuytel |
| `textures/corrugated_iron/` | https://polyhaven.com/a/corrugated_iron | Dimitrios Savva (photography), Jenelle van Heerden (processing) |
| `textures/weathered_brown_planks/` | https://polyhaven.com/a/weathered_brown_planks | Dimitrios Savva (photography), Rico Cilliers (processing) |
| `textures/green_metal_rust/` | https://polyhaven.com/a/green_metal_rust | Rob Tuytel |

**Poly Haven license** (https://polyhaven.com/license):
> "All assets (HDRIs, textures and 3D models) on this site are the original work of Poly Haven staff, or artists who willingly and directly donate/sell their work to Poly Haven. Our assets are all licensed as CC0, which is effectively Public Domain even in jurisdictions that do not support the Public Domain. [...] You can use our assets for any purpose, including commercial work. You do not need to give credit or attribution when using them (although it is appreciated). You can redistribute them, share them around, include them when sharing your own work, or even in a product you sell."

## 6. Audio (`audio/`)

### 6a. Gunshot recordings: Vincent Sevedge (CC BY 3.0, attribution required)
Files: `audio/gun_rifle_0..3.mp3`, `audio/gun_pistol_0..3.mp3`, `audio/gun_sniper_0..2.mp3`
- **Author:** Vincent Sevedge ("Tabasco" on OpenGameArt), "Copyright (c) 2009 Vincent Sevedge"
- **Source:** https://opengameart.org/content/gunshot-sounds (`sks.wav`, `cz.wav`, `mosin.wav`)
- **License:** Creative Commons Attribution 3.0 Unported, https://creativecommons.org/licenses/by/3.0/ . The OpenGameArt page lists CC0, but the bundled `creativecommons.txt` says CC BY 3.0, so the stricter licence is followed and the author is credited here and on the in-game Credits screen.
- **Changes made:** single shots sliced at detected onsets (sks 0.345/2.29/6.0/7.705 s, cz 0.23/2.82/4.05/5.54 s, mosin 0.435/3.56/5.98 s), trimmed to 0.85 to 1.4 s with a fade-out, downmixed to mono, peak-normalised, resampled to 44.1 kHz and encoded as MP3.

### 6b. Reload recordings: SpringySpringo (CC0)
Files: `audio/rifle_mag_out.mp3`, `rifle_mag_in.mp3`, `rifle_charge.mp3`, `pistol_mag_out.mp3`, `pistol_mag_in.mp3`, `bolt_cycle.mp3`
- **Source:** https://opengameart.org/content/gun-reload-sounds (`assaultriflereload1_0.wav`, `gunreload1.wav`, `shotguncock_0.wav`)
- **License:** CC0 1.0. Sliced into parts, gain lowered by 6 dB (the originals have clipped peaks), mono MP3.

### 6c. Kenney "Impact Sounds" 1.0 (CC0)
Files: `audio/footstep_{concrete,grass,wood,gravel}_0..4.mp3` (gravel is Kenney `footstep_snow`), `impact_{metal,wood,concrete,dirt,rock,glass}_*.mp3`, `hit_body_*.mp3`, `hit_armor_*.mp3`, `casing_*.mp3`, `land_*.mp3`, `grenade_bounce_*.mp3`, `dry_fire_0.mp3`; Kenney clips are also mixed into `plate_insert.mp3`, `armor_break.mp3`, `pickup.mp3` and `grenade_pin.mp3`.
- **Author:** Kenney (www.kenney.nl). **Source:** https://kenney.nl/assets/impact-sounds
- **License:** CC0 1.0 (bundled `License.txt`: "This content is free to use in personal, educational and commercial projects.")

### 6d. Original synthesized sounds (CC0)
Files: `audio/explosion_*.mp3`, `wind_loop.mp3`, `plane_loop.mp3`, `freefall_loop.mp3`, `chute_loop.mp3`, `chute_open.mp3`, `whizz_*.mp3`, `ui_*.mp3`, `hitmarker.mp3`, `hitmarker_head.mp3`, `kill_confirm.mp3`, `zone_warning.mp3`, `zone_hum_loop.mp3`, `heartbeat_loop.mp3`, and the synthesized layers of `plate_insert.mp3` and `grenade_pin.mp3`.
- Made for ZONEFALL with numpy noise/oscillator synthesis. Released under CC0 1.0.

---

### In-game credits text (must appear on the Credits screen)
"Soldiers: Microsoft Rocketbox Avatar Library (MIT). Animations: Quaternius Universal Animation Library (CC0) and Rocketbox. Weapons: Stein Games, 3dmodelscc0, Poly Haven (CC0). Props, textures and skies: Poly Haven (CC0). Gunshot recordings: Vincent Sevedge, CC BY 3.0 (opengameart.org/content/gunshot-sounds), sliced and edited. Reload sounds: SpringySpringo (CC0). Impact and footstep sounds: Kenney (CC0)."

## 7. Character outfits: Sketchfab (CC BY 4.0)

Licence: Creative Commons Attribution 4.0, http://creativecommons.org/licenses/by/4.0/. Changes for the game (by
tools/build-skins.mjs): key bones renamed, animations removed, textures resized to 1024 px and converted to WebP,
meshes over 24k triangles simplified, geometry quantised and meshopt-compressed. The shop images in
`skins/thumbs/` are renders of these models. The characters themselves belong to their respective rights holders.

| Game file | Original model | Source |
|---|---|---|
| `skins/jonesy.glb` | "Jonesy fortnite" by mochi (https://sketchfab.com/chemi.45) | https://sketchfab.com/3d-models/jonesy-fortnite-f27577cc57a4499ab132210a3c96c2b3 |
| `skins/deadpool.glb` | "Deadpool Fortnite Skin" by Neut2000 (https://sketchfab.com/Neut2000) | https://sketchfab.com/3d-models/deadpool-fortnite-skin-d1098004d7f5474eb1c5cdd6112376b1 |
| `skins/stormtrooper.glb` | "PC Computer - Fortnite - Stormtrooper" by HarrisonHag1 (https://sketchfab.com/HarrisonHag1) | https://sketchfab.com/3d-models/pc-computer-fortnite-stormtrooper-6681f4496b074eabadebea0b4cbf7abf |
| `skins/banana.glb` | "Banana Dancing Fortnite" by Jesús Dorado (https://sketchfab.com/chuchodorado416) | https://sketchfab.com/3d-models/banana-dancing-fortnite-c1db1b10f9b14717ba731d7f49d25443 |
| `skins/daffy.glb` | "Daffy Duck - Fortnite Skin" by GatoBugadoBR (https://sketchfab.com/GatoBugadoBR) | https://sketchfab.com/3d-models/daffy-duck-fortnite-skin-3b1d72feecf34d5d93ee3733b02fbbc1 |
| `skins/drake.glb` | "Fortnite - Sgt. Drake" by TheBuffalo (https://sketchfab.com/matiasjonderdiscord) | https://sketchfab.com/3d-models/fortnite-sgt-drake-4fe7a1041b6d42ccb90a26555040c5cc |
| `skins/bandit.glb` | "Fortnite Psycho Bandit from Borderlands" by Desireless (https://sketchfab.com/mmmarahmad125) | https://sketchfab.com/3d-models/fortnite-psycho-bandit-from-borderlands-47dc37bf07434c48b5d556de9a5a02de |
| `skins/rigby.glb` | "Rigby - Fortnite Sidekick" by GatoBugadoBR (https://sketchfab.com/GatoBugadoBR) | https://sketchfab.com/3d-models/rigby-fortnite-sidekick-c809262514a14bb78bc645acaafd4a90 |
| `skins/lizard.glb` | "Tom Lizard Fortnite Skin" by Fortnite Models (The Realm Geno YT) (https://sketchfab.com/TheRealmGeno) | https://sketchfab.com/3d-models/tom-lizard-fortnite-skin-653ed180eb5842089080300631adfb7c |
| `skins/huggy.glb` | "Huggy Wuggy/Fortnite" by Elite Big Speakerman (https://sketchfab.com/EvesStudio2008) | https://sketchfab.com/3d-models/huggy-wuggyfortnite-f771667a106749dab4780df426a6d62c |
| `skins/spongebob.glb` | "Spongebob Squarepants Fortnite" by Guilherme Navarro (https://sketchfab.com/guinavarro.al) | https://sketchfab.com/3d-models/spongebob-squarepants-fortnite-e3828b82d07044b88b52c96fde0d74fd |

## 8. Vehicles, Downtown, Batman and the RPG: Sketchfab

Converted by tools/build-models.mjs (simplified, textures resized to WebP, quantised, meshopt-compressed; Batman was
rigged onto the game's 20-bone skeleton there; the RPG was rescaled and given weapon sockets; Downtown was scaled to
0.85). The characters, vehicles and brands shown belong to their respective rights holders.

| Game file | Original model | Licence | Source |
|---|---|---|---|
| `vehicles/plane.glb` | "Toon Plane" by Spacca (https://sketchfab.com/Spacca) | CC BY 4.0 | https://sketchfab.com/3d-models/toon-plane-ad5fbeef2fae418789ddba0945b1e03c |
| `weapons/sketchfab/rpg.glb` | "Fortnite RPG" by Ghozali.Ghozalu (https://sketchfab.com/Ghozali.Ghozalu) | CC BY 4.0 | https://sketchfab.com/3d-models/fortnite-rpg-17dbea91790c48e0a57588ad37d79e80 |
| `vehicles/p1.glb` | "AC - Mclaren P1 [FREE]" by Meshava (https://sketchfab.com/7093) | Sketchfab Standard | https://sketchfab.com/3d-models/ac-mclaren-p1-free-747cedadc302451db61deafc85941395 |
| `skins/batman.glb` | "Bruce Wayne Batman Arkham City" by Tigerar1 (https://sketchfab.com/allanromanreyes) | Sketchfab Standard | https://sketchfab.com/3d-models/bruce-wayne-batman-arkham-city-b786e850419b429db10accd4e6052c43 |
| `props/city/city.glb` | "Procedural City 3" by abhayexe (https://sketchfab.com/abhayexe) | Sketchfab Standard | https://sketchfab.com/3d-models/procedural-city-3-56002f4a388745388911a45cf677a7a2 |
