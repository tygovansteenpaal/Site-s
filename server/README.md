# ZONEFALL server

Host ZONEFALL on your own computer (Windows or Mac) and play with friends on your network or over the internet.
The public version on Vercel / GitHub Pages keeps working next to it.

## Start it

**Ready-made program (no Python needed).** In GitHub: Actions > "ZONEFALL server builds" > Run workflow. When it
finishes, download `ZONEFALL-Server-Windows` or `ZONEFALL-Server-macOS` from the run's Artifacts and start it.
On a Mac, the first time: right-click the file > Open (it is not signed).

**From this folder (Python 3.10+ installed).**
- Mac: double-click `Start ZONEFALL server (Mac).command`
- Windows: double-click `Start ZONEFALL server (Windows).bat`

The first start installs Flask into a private `.venv` here; after that it starts straight away. The window shows
the addresses to play on and opens the game in your browser:

```
On this computer:  https://localhost:8443/zonefall/
On your network:   https://192.168.1.20:8443/zonefall/
```

Options: `--port 9000`, `--host 0.0.0.0`, `--no-browser`, `--http` (plain HTTP; then only `localhost` can play
online, because browsers allow the game's networking only on https or localhost).

## Playing with others

- **Same network (home, school):** others open the "On your network" address. They see a certificate warning once
  (the server uses its own certificate): choose *Advanced* > *Proceed*. Then Quick Play or a private match code.
- **Over the internet:** forward TCP port 8443 on your router to this computer and share
  `https://<your public IP>:8443/zonefall/`. Players behind strict company or school firewalls may still fail to
  connect directly to each other (the game's traffic is peer to peer; the server only introduces players).

## How it works

`zonefall_server.py` (Flask) serves the `zonefall/` game folder, runs a small Nostr relay on `/relay` and answers
`/zonefall/server.json`. The game reads that file at connect time and then uses this server's relay instead of
the public ones, so lobbies on your server are only visible to players on your server. `/status` shows the number
of connected players.

Build the single-file program yourself: `pip install pyinstaller -r requirements.txt && pyinstaller zonefall_server.spec`
(build on Windows for Windows, on a Mac for macOS).
