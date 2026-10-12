# Site-s

Live projects by [Tygo van Steenpaal](https://github.com/tygovansteenpaal), served with GitHub Pages.

| Project | What it is | Live |
|---|---|---|
| **Blokbrawl** | Cartoon 1v1 build-and-shoot game. Walls, ramps, floors, an AR and a shotgun against a bot that builds back. Three.js. | [/blokbrawl](https://tygovansteenpaal.github.io/Site-s/blokbrawl/) |
| **Huddle** | Team chat in the spirit of Teams: channels, DMs, threads, reactions, mentions, file sharing, search (Ctrl K) and a call screen with camera and screen share. Syncs between open tabs. | [/huddle](https://tygovansteenpaal.github.io/Site-s/huddle/) |
| **Stash** | My own game marketplace: accounts, currency, items, boosting and top ups. Filters, search, cart and order requests by email. | [/stash](https://tygovansteenpaal.github.io/Site-s/stash/) |

## Run locally

No build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## Stash: selling for real

Everything Stash sells lives in [`stash/data.js`](stash/data.js):

- `store.contact` is where order requests are emailed.
- `listings` is the stock. Replace the sample listings with your own.
- Set `store.sampleStock` to `false` to remove the sample ribbon.

## Stack

Plain HTML, CSS and JavaScript. Three.js for Blokbrawl, Lucide for icons, Anton, DM Mono and Geist for type.
