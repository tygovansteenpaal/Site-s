// ZONEFALL - local fake transport for NET tests. OWNER: NET. Not part of the ARCHITECTURE.md contract (internal to net/).
// Implements the subset of the Trystero room API that net/session.js uses (makeAction, onPeerJoin/onPeerLeave,
// getPeers, ping, leave, the onPeerHandshake/onJoinError callbacks) over a BroadcastChannel, so two tabs or two pages
// of one browser profile form a real room without relays. Selected with `?net=local` (or connect({transport:'local'})).
// Network conditions (latency, jitter, loss) can be simulated per page with setLinkConditions(): reliable messages get
// the base latency and stay ordered, unreliable (snapshot channel) messages also get jitter and random loss.

const ANNOUNCE_MS = 1000;      // presence beacon
const TIMEOUT_MS = 10000;      // abrupt-leave detection, the same order as Trystero's (~10 s)
const OPEN_DELAY_MS = 120;     // the unreliable channel opens a moment after the peer joins, like SCTP does

const link = { latency: 0, jitter: 0, loss: 0 };

/** Simulated network conditions for this page: {latency ms, jitter ms, loss 0..1}. */
export function setLinkConditions(c = {}) {
  if (Number.isFinite(c.latency)) link.latency = Math.max(0, Math.min(1000, c.latency));
  if (Number.isFinite(c.jitter)) link.jitter = Math.max(0, Math.min(500, c.jitter));
  if (Number.isFinite(c.loss)) link.loss = Math.max(0, Math.min(0.9, c.loss));
  return { ...link };
}
export const linkConditions = () => ({ ...link });

function channelName(appId, roomId, password) {
  // The password is part of the channel name, so rooms with different passwords never see each other.
  let h = 2166136261;
  const s = `${appId}|${roomId}|${password || ''}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `zf-local:${appId}:${roomId}:${(h >>> 0).toString(36)}`;
}

/**
 * @param {{appId:string, password?:string}} config
 * @param {string} roomId
 * @param {{onPeerHandshake?:Function, onJoinError?:Function}} callbacks
 * @param {string} selfId
 */
export function joinLocalRoom(config, roomId, callbacks = {}, selfId) {
  if (typeof BroadcastChannel !== 'function') throw new Error('[NET/localroom] BroadcastChannel is not available');
  const bc = new BroadcastChannel(channelName(config.appId, roomId, config.password));
  const peers = new Map();       // id -> {id, joined, handshaking, rejected, lastHeard, hsInbox, hsWaiters, remoteReady, localPassed, chan}
  const actions = new Map();     // name -> {onMessage}
  const pings = new Map();       // n -> resolve
  let pingSeq = 0, left = false;
  const timers = [];

  const room = {
    onPeerJoin: null,
    onPeerLeave: null,
    makeAction(name) {
      if (actions.has(name)) return actions.get(name).api;
      const entry = { onMessage: null, api: null };
      entry.api = {
        send: (data, opts = {}) => {
          if (left) return Promise.resolve();
          const target = opts && opts.target ? opts.target : null;
          post({ k: 'act', to: target, name, data }, false);
          return Promise.resolve();
        },
        set onMessage(fn) { entry.onMessage = fn; },
        get onMessage() { return entry.onMessage; },
      };
      actions.set(name, entry);
      return entry.api;
    },
    getPeers() {
      const out = {};
      for (const p of peers.values()) if (p.joined) out[p.id] = null; // no RTCPeerConnection behind a local peer
      return out;
    },
    ping(id) {
      const p = peers.get(id);
      if (!p || !p.joined) return Promise.reject(new Error(`no active peer with id ${id}`));
      const n = ++pingSeq, t = performance.now();
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => { pings.delete(n); reject(new Error('ping timeout')); }, 5000);
        pings.set(n, () => { clearTimeout(to); resolve(performance.now() - t); });
        post({ k: 'ping', to: id, n }, false);
      });
    },
    /** Local-only: an unreliable, unordered "data channel" to one peer (net/session uses it instead of RTCPeerConnection). */
    openUnreliable(id) {
      const p = peers.get(id);
      const ch = {
        readyState: 'connecting', bufferedAmount: 0, onmessage: null, onopen: null, onclose: null, binaryType: 'arraybuffer',
        send(buf) { if (ch.readyState === 'open') post({ k: 'u', to: id, data: buf }, true); },
        close() {
          if (ch.readyState === 'closed') return;
          ch.readyState = 'closed';
          if (p && p.chan === ch) p.chan = null;
          ch.onclose && ch.onclose();
        },
      };
      if (!p || !p.joined) { ch.readyState = 'closed'; return ch; }
      p.chan = ch;
      setTimeout(() => {
        if (ch.readyState !== 'connecting' || left) return;
        ch.readyState = 'open';
        ch.onopen && ch.onopen();
      }, OPEN_DELAY_MS + link.latency);
      return ch;
    },
    leave() {
      if (left) return Promise.resolve();
      left = true;
      try { bc.postMessage({ k: 'leave', from: selfId }); } catch { /* channel already closed */ }
      for (const t of timers) clearInterval(t);
      for (const p of peers.values()) if (p.chan) p.chan.close();
      peers.clear();
      setTimeout(() => bc.close(), 50);
      return Promise.resolve();
    },
  };

  function post(msg, unreliable) {
    msg.from = selfId;
    if (left) return;
    if (unreliable && link.loss > 0 && Math.random() < link.loss) return;
    const delay = link.latency + (unreliable && link.jitter > 0 ? Math.random() * link.jitter : 0);
    if (delay <= 0) { try { bc.postMessage(msg); } catch { /* closed */ } return; }
    setTimeout(() => { if (!left) { try { bc.postMessage(msg); } catch { /* closed */ } } }, delay);
  }

  function peer(id) {
    let p = peers.get(id);
    if (!p) {
      p = { id, joined: false, handshaking: false, rejected: false, lastHeard: performance.now(), hsInbox: [], hsWaiters: [],
        remoteReady: false, localPassed: false, chan: null };
      peers.set(id, p);
    }
    return p;
  }

  function startHandshake(p) {
    if (p.handshaking || p.joined || p.rejected) return;
    p.handshaking = true;
    const send = (data) => { post({ k: 'hs', to: p.id, data }, false); return Promise.resolve(); };
    const receive = () => new Promise((resolve) => {
      if (p.hsInbox.length) resolve({ data: p.hsInbox.shift(), metadata: undefined });
      else p.hsWaiters.push((data) => resolve({ data, metadata: undefined }));
    });
    const run = callbacks.onPeerHandshake ? Promise.resolve().then(() => callbacks.onPeerHandshake(p.id, send, receive, selfId < p.id)) : Promise.resolve();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('handshake timed out')), 10000));
    Promise.race([run, timeout]).then(() => {
      if (left || !peers.has(p.id)) return;
      p.localPassed = true;
      post({ k: 'hsok', to: p.id }, false);
      maybeActivate(p);
    }, (err) => {
      p.handshaking = false;
      p.rejected = true;
      post({ k: 'hsfail', to: p.id }, false);
      callbacks.onJoinError && callbacks.onJoinError({ error: `handshake failed: ${err && err.message || err}`, peerId: p.id, roomId, appId: config.appId });
    });
  }

  function maybeActivate(p) {
    if (p.joined || !p.localPassed || !p.remoteReady) return;
    p.joined = true;
    p.handshaking = false;
    room.onPeerJoin && room.onPeerJoin(p.id);
  }

  function dropPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    if (p.chan) p.chan.close();
    if (p.joined) room.onPeerLeave && room.onPeerLeave(id);
  }

  bc.onmessage = (ev) => {
    const m = ev.data;
    if (left || !m || typeof m !== 'object' || m.from === selfId || !m.from) return;
    if (m.to && m.to !== selfId) return;
    if (m.k === 'leave') { dropPeer(m.from); return; }
    const p = peer(m.from);
    p.lastHeard = performance.now();
    switch (m.k) {
      case 'ann':
        if (p.rejected && m.fresh) { p.rejected = false; }
        if (!p.joined) startHandshake(p);
        break;
      case 'hs':
        if (!p.joined) startHandshake(p);
        if (p.hsWaiters.length) p.hsWaiters.shift()(m.data); else p.hsInbox.push(m.data);
        break;
      case 'hsok': p.remoteReady = true; maybeActivate(p); break;
      case 'hsfail': p.rejected = true; p.handshaking = false; break;
      case 'act': {
        if (!p.joined) return;
        const a = actions.get(m.name);
        if (a && a.onMessage) a.onMessage(m.data, { peerId: m.from, metadata: undefined });
        break;
      }
      case 'u':
        if (p.joined && p.chan && p.chan.readyState === 'open' && p.chan.onmessage) p.chan.onmessage({ data: m.data });
        break;
      case 'ping': post({ k: 'pong', to: m.from, n: m.n }, false); break;
      case 'pong': { const r = pings.get(m.n); if (r) { pings.delete(m.n); r(); } break; }
      default: break;
    }
  };

  const announce = (fresh) => { if (!left) bc.postMessage({ k: 'ann', from: selfId, fresh: !!fresh }); };
  announce(true);
  timers.push(setInterval(() => announce(false), ANNOUNCE_MS));
  timers.push(setInterval(() => {
    const now = performance.now();
    for (const p of [...peers.values()]) if (now - p.lastHeard > TIMEOUT_MS) dropPeer(p.id);
  }, 1000));

  return room;
}
