# Project skills

Agent Skills that Claude Code loads on demand when working in this repo.

## Game-dev skills (77 + router)

Source: [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)
at commit `dcf3bbbb83f365632402c086bf595048aa24aaa8`, Apache-2.0 (see `LICENSE-gamedev-skills` and
`NOTICE-gamedev-skills`).

All 77 skills plus the `router` are installed, flattened to `.claude/skills/<name>/` (upstream groups
them under `skills/<group>/`). The Codex-only `agents/openai.yaml` files are left out.

| Group | Skills |
|---|---|
| Router | `router`: start here for any game-dev task |
| Roblox | `roblox-luau`, `roblox-networking`, `roblox-datastores`, `roblox-characters`, `roblox-physics`, `roblox-ui`, `roblox-studio-workflow`, `roblox-simulator-economy` |
| Web | `threejs-scene-setup`, `threejs-gltf-loading`, `threejs-materials-lighting`, `phaser-core`, `phaser-arcade-physics`, `pixijs-rendering` |
| Other engines | `bevy-ecs`, `defold-core`, `love2d-core`, `pygame-core`, `ebitengine-game` |
| Godot | 16 `godot-*` skills |
| Unity | 8 `unity-*` skills |
| Unreal | 6 `unreal-*` skills |
| Disciplines | `performance-optimization`, `game-feel`, `game-ai`, `ai-behavior-trees-utility-ai`, `camera-systems`, `input-systems`, `physics-tuning`, `shader-programming`, `audio-design`, `game-ui-ux`, `level-design`, `procedural-gen`, `save-systems`, `dialogue-systems`, `create-game-assets` |
| Genres | `fps-shooter`, `platformer`, `roguelike`, `rpg`, `tower-defense`, `card-game`, `visual-novel`, `survival-crafting`, `puzzle` |
| Workflows | `prototype-fast`, `game-jam`, `itch-publish`, `steam-publish` |

The three.js skills target r186; the games here pin `three@0.185.1`, so check the installed
version before applying an API change from them.

To update: copy the folders from a newer upstream commit again (flattened), drop
`agents/openai.yaml`, and update the hash above.

## Own skills

| Skill | What it does |
|---|---|
| `lean-quality` | Working rules for low token usage at full quality: size the task, read cheaply, load skills minimally, verify once for real, reply short. |
