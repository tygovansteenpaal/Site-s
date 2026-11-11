# Project skills

Game-dev Agent Skills that Claude Code loads on demand when working in this repo.

Source: [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)
at commit `dcf3bbbb83f365632402c086bf595048aa24aaa8`, Apache-2.0 (see `LICENSE-gamedev-skills` and `NOTICE-gamedev-skills`).

Only the skills that fit this site are included: Blokbrawl and ZONEFALL are three.js browser games
(ZONEFALL is a peer-to-peer battle royale with bots, cars and an RPG). The Godot, Unity, Unreal,
Bevy, Ebitengine, Phaser, PixiJS, Roblox and other-genre skills are left out, and so is the
upstream `router`, because it routes to the full 77-skill catalog.

| Group | Skills |
|---|---|
| three.js | `threejs-scene-setup`, `threejs-gltf-loading`, `threejs-materials-lighting` |
| Disciplines | `performance-optimization`, `game-feel`, `game-ai`, `ai-behavior-trees-utility-ai`, `camera-systems`, `input-systems`, `physics-tuning`, `shader-programming`, `audio-design`, `game-ui-ux`, `level-design`, `procedural-gen`, `save-systems` |
| Genre | `fps-shooter` |
| Workflow | `prototype-fast` |

The three.js skills target r186; the games pin `three@0.185.1`, so check the installed version
before applying an API change from them.

To update, copy the same folders again from a newer upstream commit and update the hash above.
