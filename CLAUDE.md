# CLAUDE.md

Plain HTML/CSS/JS site served by GitHub Pages; no build step. Games: Blokbrawl and ZONEFALL
(three.js, pinned `three@0.185.1`). Apps: Huddle, Stash. See `README.md`.

## Skills (`.claude/skills/`)

- **Every task:** follow `lean-quality` (low token use, full quality).
- **Any game-dev task** (browser, three.js, Roblox, Godot, Unity, ...): start with `router`. It
  picks the minimal engine + discipline + genre + workflow skills; load only those.
- The router names paths like `skills/web-engines/threejs-scene-setup/`. Here every skill lives
  flat at `.claude/skills/<skill-name>/SKILL.md`, so use the last path part as the skill name.
- Skill source and update steps: `.claude/skills/README.md`.

## Checks

- Serve with `python3 -m http.server 8000` and load the page in Playwright to verify a change.
