"""ZONEFALL server: host the game on your own computer and play with people on your network (or the internet).

What it does
  * Serves the game (the zonefall/ folder next to this one) at https://<this computer>:8443/zonefall/
  * Runs a small Nostr relay at /relay. Players' browsers find each other through it instead of the public relays,
    so matchmaking works without internet access and nobody outside your server sees your lobbies. The game
    itself still connects players directly (WebRTC); the server only passes the connection handshake.
  * Publishes /zonefall/server.json, which tells the game to use this relay. The same game on Vercel or GitHub
    Pages has no such file and keeps using the public relays, so both keep working side by side.

HTTPS: browsers only allow the game's networking (WebCrypto) on https:// or on localhost. The server creates a
self-signed certificate on first start (server/cert/). Other players see a security warning once and choose
"Advanced" > "Proceed". Use --http to serve plain HTTP (then only http://localhost works for multiplayer).

Run:  python zonefall_server.py [--port 8443] [--host 0.0.0.0] [--http] [--no-browser]
"""
from __future__ import annotations

import argparse
import datetime
import ipaddress
import json
import logging
import mimetypes
import os
import socket
import sys
import threading
import time
import webbrowser
from collections import deque

from flask import Flask, Response, abort, jsonify, redirect, send_from_directory
from flask_sock import Sock

VERSION = "1.0.0"

# --------------------------------------------------------------------------------------------- paths
if getattr(sys, "frozen", False):                      # PyInstaller bundle: data next to the executable code
    BUNDLE = sys._MEIPASS                              # type: ignore[attr-defined]
    GAME_ROOT = os.path.join(BUNDLE, "site")
    DATA_DIR = os.path.join(os.path.dirname(sys.executable), "zonefall-server-data")
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
    GAME_ROOT = os.path.dirname(HERE)                  # the repository root (holds zonefall/)
    DATA_DIR = HERE
CERT_DIR = os.path.join(DATA_DIR, "cert")

for ext, mime in ((".glb", "model/gltf-binary"), (".webp", "image/webp"), (".js", "text/javascript"),
                  (".mjs", "text/javascript"), (".hdr", "image/vnd.radiance"), (".mp3", "audio/mpeg"),
                  (".json", "application/json"), (".wasm", "application/wasm")):
    mimetypes.add_type(mime, ext)

app = Flask(__name__, static_folder=None)
logging.getLogger('werkzeug').setLevel(logging.WARNING)   # no line per request
try:
    import flask.cli
    flask.cli.show_server_banner = lambda *a, **k: None    # the dev-server banner only confuses players
except Exception:
    pass
sock = Sock(app)


# --------------------------------------------------------------------------------------------- game files
@app.get("/")
def root():
    return redirect("/zonefall/")


@app.get("/zonefall/server.json")
def server_info():
    return jsonify({"relays": ["/relay"], "name": socket.gethostname(), "version": VERSION})


@app.get("/zonefall/")
@app.get("/zonefall/<path:path>")
def game(path: str = "index.html"):
    full = os.path.join(GAME_ROOT, "zonefall", path)
    if os.path.isdir(full):
        path = path.rstrip("/") + "/index.html"
    # never serve the server's own folder or dotfiles through the game route
    if any(part.startswith(".") for part in path.split("/")):
        abort(404)
    resp = send_from_directory(os.path.join(GAME_ROOT, "zonefall"), path)
    if path.endswith((".glb", ".webp", ".jpg", ".hdr", ".mp3")):
        resp.headers["Cache-Control"] = "public, max-age=86400"
    else:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# --------------------------------------------------------------------------------------------- Nostr relay
# The subset of NIP-01 Trystero uses: EVENT (publish), REQ (subscribe with kinds / #x tags / since), CLOSE.
# Events are kept for RECENT_S seconds so a subscriber that arrives a moment late still gets the last offers.
RECENT_S = 30
MAX_EVENT_BYTES = 64 * 1024
recent: deque = deque(maxlen=4000)
clients: dict = {}                                    # ws -> {sub id: [filters]}
lock = threading.Lock()
stats = {"events": 0, "peak": 0}


def matches(f: dict, ev: dict) -> bool:
    if "ids" in f and ev.get("id") not in f["ids"]:
        return False
    if "authors" in f and ev.get("pubkey") not in f["authors"]:
        return False
    if "kinds" in f and ev.get("kind") not in f["kinds"]:
        return False
    ts = ev.get("created_at", 0)
    if "since" in f and ts < f["since"]:
        return False
    if "until" in f and ts > f["until"]:
        return False
    for key, wanted in f.items():
        if key.startswith("#") and len(key) == 2:
            values = {t[1] for t in ev.get("tags", []) if isinstance(t, list) and len(t) > 1 and t[0] == key[1]}
            if not values.intersection(wanted):
                return False
    return True


def send(ws, msg) -> bool:
    try:
        ws.send(json.dumps(msg, separators=(",", ":")))
        return True
    except Exception:
        return False


@sock.route("/relay")
def relay(ws):
    with lock:
        clients[ws] = {}
        stats["peak"] = max(stats["peak"], len(clients))
    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            if len(raw) > MAX_EVENT_BYTES:
                send(ws, ["NOTICE", "message too large"])
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, list) or not msg:
                continue
            kind = msg[0]
            if kind == "EVENT" and len(msg) >= 2 and isinstance(msg[1], dict):
                ev = msg[1]
                send(ws, ["OK", ev.get("id", ""), True, ""])
                stats["events"] += 1
                now = time.time()
                with lock:
                    recent.append((now, ev))
                    targets = [(c, sid) for c, subs in clients.items() if c is not ws
                               for sid, fl in subs.items() if any(matches(f, ev) for f in fl)]
                for c, sid in targets:
                    send(c, ["EVENT", sid, ev])
            elif kind == "REQ" and len(msg) >= 2 and isinstance(msg[1], str):
                sid, filters = msg[1], [f for f in msg[2:] if isinstance(f, dict)]
                cutoff = time.time() - RECENT_S
                with lock:
                    clients[ws][sid] = filters
                    backlog = [ev for (t, ev) in recent if t >= cutoff and any(matches(f, ev) for f in filters)]
                for ev in backlog:
                    send(ws, ["EVENT", sid, ev])
                send(ws, ["EOSE", sid])
            elif kind == "CLOSE" and len(msg) >= 2:
                with lock:
                    clients.get(ws, {}).pop(msg[1], None)
    finally:
        with lock:
            clients.pop(ws, None)


@app.get("/status")
def status():
    with lock:
        n = len(clients)
    return jsonify({"version": VERSION, "relay_clients": n, "peak_clients": stats["peak"], "events": stats["events"]})


# --------------------------------------------------------------------------------------------- HTTPS
def lan_addresses() -> list[str]:
    out = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))                # no packet is sent; picks the outgoing interface
        out.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            out.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in out if not a.startswith("127."))


def ensure_cert() -> tuple[str, str]:
    """Self-signed certificate for localhost, this computer's name and its LAN addresses (made once)."""
    crt, key = os.path.join(CERT_DIR, "zonefall.crt"), os.path.join(CERT_DIR, "zonefall.key")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    os.makedirs(CERT_DIR, exist_ok=True)
    pk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ZONEFALL server")])
    alt = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname()), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    alt += [x509.IPAddress(ipaddress.ip_address(a)) for a in lan_addresses()]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(pk.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .sign(pk, hashes.SHA256()))
    with open(key, "wb") as f:
        f.write(pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    with open(crt, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return crt, key


# --------------------------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description="Host ZONEFALL on this computer.")
    ap.add_argument("--host", default="0.0.0.0", help="interface to listen on (default: all)")
    ap.add_argument("--port", type=int, default=None, help="port (default 8443, or 8080 with --http)")
    ap.add_argument("--http", action="store_true", help="plain HTTP (multiplayer then only works on localhost)")
    ap.add_argument("--no-browser", action="store_true", help="do not open the game in a browser")
    args = ap.parse_args()

    if not os.path.exists(os.path.join(GAME_ROOT, "zonefall", "index.html")):
        sys.exit(f"Game files not found in {os.path.join(GAME_ROOT, 'zonefall')}")
    port = args.port or (8080 if args.http else 8443)
    scheme = "http" if args.http else "https"
    ssl_ctx = None if args.http else ensure_cert()

    print(f"\n  ZONEFALL server {VERSION}")
    print(f"  On this computer:  {scheme}://localhost:{port}/zonefall/")
    for a in lan_addresses():
        print(f"  On your network:   {scheme}://{a}:{port}/zonefall/")
    if not args.http:
        print("  Other players: accept the certificate warning once (Advanced > Proceed).")
    print("  Over the internet: forward TCP port %d on your router to this computer and share your public IP." % port)
    print("  Press Ctrl+C to stop.\n")

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"{scheme}://localhost:{port}/zonefall/")).start()
    app.run(host=args.host, port=port, ssl_context=ssl_ctx, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
