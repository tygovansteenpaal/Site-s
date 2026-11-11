---
name: lean-quality
description: >
  Working rules that cut token usage hard without lowering the quality of the result. Use at the
  start of every coding, game-dev (browser, three.js, Roblox/Luau) or writing task in this repo,
  and whenever a task is large, touches many files, or risks long exploration. Covers how much to
  think, how to read code cheaply, which skills to load, when not to use subagents, how to verify,
  and how short the reply should be.
---

# Lean Quality

Goal: a top-quality result for the fewest tokens. Tokens go to **deciding and verifying**, not to
re-reading, re-explaining or exploring what the task doesn't need.

## 1. Size the task first (5 seconds)

| Size | Signal | Thinking | Plan |
|---|---|---|---|
| Small | one file, clear ask, known pattern | short | none, just do it |
| Medium | a few files, one feature | moderate | 3-6 line plan in your head |
| Large | new game/system, architecture, unclear cause | deep, once, up front | written plan, then execute without re-planning |

Think hard **once**, where the decision is made (architecture, root cause, game design). Don't
re-derive settled facts or re-litigate a choice the user already made. When unsure between two
approaches, pick one and say why in one line; don't survey options you won't use.

## 2. Read cheaply

- Search before reading: `Grep`/`Glob` for the symbol, then read only the relevant line range
  (`offset`/`limit`), not whole files. Big files (e.g. `zonefall/src/*`, `blokbrawl/index.html`)
  are never read in full unless the change spans them.
- Read each file once. Never re-read a file you just edited to "check"; the edit tool already
  failed loudly if it didn't apply.
- Independent reads and searches go in **one parallel batch**, not one per turn.
- Trust what is already in the conversation; don't fetch it again.

## 3. Load skills minimally

- Game-dev task: let `router` pick the **minimal** set (one engine skill + only the disciplines the
  task names). Read a skill's `SKILL.md`; open its `references/` only when you hit that exact
  sub-problem.
- Don't load a skill "just in case". Don't reload a skill already loaded this session.
- Roblox: `roblox-luau` is the base; add `roblox-networking` only for remotes, `roblox-datastores`
  only for saving, etc. Browser 3D: `threejs-*` matching the sub-task; check the project's pinned
  `three` version before using an API.

## 4. No expensive detours

- No subagents unless the user asks or the search truly fans out over many unknown locations.
  Each subagent re-reads context from scratch.
- No speculative refactors, extra features, or "while I'm here" changes. Do what was asked, fully.
- No full-repo scans per change. No re-running a long test suite when one targeted test proves it.

## 5. Quality bar (never cut these)

Cheap is only good if the result is right. Always:

1. **Complete code**: no placeholders, TODOs, or "rest stays the same" in delivered code.
2. **Fits the codebase**: same style, naming, structure and libraries as the surrounding code.
3. **Edge cases that matter**: for games, respawn/death, resize, tab switch, low FPS, re-entry,
   cleanup of loops/listeners. For Roblox: server authority, remote validation, character
   lifecycle.
4. **Verify once, for real**: run it, load the page with Playwright, run the relevant test or
   syntax check. One meaningful check beats three shallow ones. If you couldn't verify, say so.
5. **Performance by default**: no per-frame allocations, no per-frame scans, pool and batch where
   the game loop is hot.

## 6. Edit cheaply

- Use targeted `Edit`s, not full-file rewrites, unless most of the file changes.
- Group related edits to one file in as few calls as possible.

## 7. Reply short

- Lead with what changed and whether it works; then only what the user must know or decide.
- No restating the request, no narrating each step, no repeating code that's already in a file.
- Use a table or a short list instead of paragraphs when comparing.

## Self-check before finishing

- Did I read anything I didn't need? (Learn for next turn.)
- Is the result complete, verified, and in the codebase's style?
- Is the reply the shortest version that still says everything important?
