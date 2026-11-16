// BLOKSTORM - talking to other players. Three transports with one interface:
//   offline  no network, you are the host (practice with bots)
//   p2p      Trystero over WebRTC, browsers connect straight to each other
//   local    BroadcastChannel between tabs of one browser, for testing
// The player who made the lobby is the host. Messages: hello, snap, ev (events), in (intents), pose.
import { APP_ID, RELAYS } from './config.js';

function localRoom(roomId, selfId) {
  const bc = new BroadcastChannel(`${APP_ID}:${roomId}`);
  const actions = new Map(), peers = new Set();
  const room = {
    onPeerJoin: null, onPeerLeave: null,
    makeAction(name) {
      const a = { onMessage: null, send: (data, opts = {}) => { bc.postMessage({ k: 'act', name, data, from: selfId, to: opts.target || null }); return Promise.resolve(); } };
      actions.set(name, a);
      return a;
    },
    leave() { bc.postMessage({ k: 'bye', from: selfId }); bc.close(); },
  };
  bc.onmessage = (e) => {
    const m = e.data;
    if (!m || m.from === selfId || (m.to && m.to !== selfId)) return;
    if (m.k === 'hi' || m.k === 'hi2') {
      if (m.k === 'hi') bc.postMessage({ k: 'hi2', from: selfId, to: m.from });
      if (!peers.has(m.from)) { peers.add(m.from); room.onPeerJoin && room.onPeerJoin(m.from); }
    } else if (m.k === 'bye') { if (peers.delete(m.from)) room.onPeerLeave && room.onPeerLeave(m.from); }
    else if (m.k === 'act') { const a = actions.get(m.name); a && a.onMessage && a.onMessage(m.data, { peerId: m.from }); }
  };
  setTimeout(() => bc.postMessage({ k: 'hi', from: selfId }), 50);
  addEventListener('pagehide', () => { try { room.leave(); } catch { /* closed */ } });
  return room;
}

export class Net {
  /** h: {onEvent(e), onPose(map), onIntent(from, m), onHello(from, info), onSnap(snap), onLeave(id), onHostLost()} */
  constructor(h) {
    this.h = h;
    this.room = null; this.acts = {};
    this.selfId = 'me' + Math.random().toString(36).slice(2, 8);
    this.hostId = this.selfId; this.isHost = true; this.online = false; this.code = '';
    this.peers = new Set();
  }

  offline() { this.leave(); this.isHost = true; this.hostId = this.selfId; this.online = false; this.code = ''; }

  async connect(code, asHost, hello) {
    this.leave();
    const kind = new URLSearchParams(location.search).get('net') === 'local' ? 'local' : 'p2p';
    this.code = code; this.isHost = asHost; this.hostId = asHost ? this.selfId : null; this.hello = hello;
    let room;
    if (kind === 'local') room = localRoom(code, this.selfId);
    else {
      const mod = await import('trystero');
      this.selfId = mod.selfId;
      if (asHost) this.hostId = this.selfId;
      const config = { appId: APP_ID, relayConfig: { urls: RELAYS } };
      try {
        const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('/api/turn', { signal: ctl.signal, cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (j && Array.isArray(j.iceServers) && j.iceServers.length) config.turnConfig = j.iceServers;
      } catch { /* no relay server configured: direct connections only */ }
      room = mod.joinRoom(config, code);
    }
    this.room = room; this.online = true;
    for (const name of ['hello', 'snap', 'ev', 'in', 'pose']) {
      const a = room.makeAction(name);
      a.onMessage = (data, meta) => this.#recv(name, data, meta && typeof meta === 'object' ? meta.peerId : meta);
      this.acts[name] = a;
    }
    room.onPeerJoin = (id) => {
      this.peers.add(id);
      if (!this.isHost) this.acts.hello.send(this.hello(), { target: id });
    };
    room.onPeerLeave = (id) => {
      this.peers.delete(id);
      if (this.isHost) this.h.onLeave(id);
      else if (id === this.hostId) this.h.onHostLost();
    };
  }

  #recv(name, data, from) {
    if (name === 'hello') { if (this.isHost) this.h.onHello(from, data); }
    else if (name === 'snap') { if (!this.isHost && (!this.hostId || this.hostId === from)) { this.hostId = from; this.h.onSnap(data); } }
    else if (name === 'ev') { if (!this.isHost && from === this.hostId) this.h.onEvent(data); }
    else if (name === 'in') { if (this.isHost) this.h.onIntent(from, data); }
    else if (name === 'pose') this.h.onPose(data, from);
  }

  /** Player -> host. The host handles its own requests straight away. */
  intent(m) {
    if (this.isHost) this.h.onIntent(this.selfId, m);
    else if (this.hostId && this.acts.in) this.acts.in.send(m, { target: this.hostId });
  }
  /** Host -> players. */
  event(e, to) {
    if (!to || to === this.selfId) this.h.onEvent(e);
    if (!this.online || to === this.selfId || !this.acts.ev) return;
    if (to) { if (this.peers.has(to)) this.acts.ev.send(e, { target: to }); }
    else if (this.peers.size) this.acts.ev.send(e);
  }
  snap(to, data) { if (this.acts.snap) this.acts.snap.send(data, { target: to }); }
  pose(map) { if (this.online && this.peers.size && this.acts.pose) this.acts.pose.send(map); }

  leave() {
    if (this.room) { try { const p = this.room.leave(); if (p && p.catch) p.catch(() => {}); } catch { /* gone */ } }
    this.room = null; this.acts = {}; this.peers.clear(); this.online = false;
  }
}
