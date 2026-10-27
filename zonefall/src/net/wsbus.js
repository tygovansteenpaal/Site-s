// ZONEFALL - server relay bus. OWNER: NET. Internal to net/.
// A BroadcastChannel-like bus over one WebSocket to the ZONEFALL server (server/zonefall_server.py, route /room).
// net/localroom.js runs its room protocol on top of it, so every message (handshake, actions, snapshots) goes through
// the server instead of a direct WebRTC connection. Used when the page is served by the server app: networks that
// block peer-to-peer traffic (school, office) still work as long as everyone can open the page.
// Frames are JSON; ArrayBuffers and typed arrays travel as {"$b": base64}. Messages sent before the socket opens are
// queued, and a dropped socket reconnects (localroom's 1 s announce beacon then restores the room).

const RECONNECT_MS = 1000;
const MAX_QUEUE = 500;

function b64(buf) {
  const u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

const encode = (msg) => JSON.stringify(msg, function (k, v) {
  const raw = this[k];
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return { $b: b64(raw) };
  return v;
});

const decode = (text) => JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' && Object.keys(v).length === 1 ? unb64(v.$b) : v));

/** Status of the open buses, for session.countRelays(). */
const buses = new Set();
export const openCount = () => { let n = 0; for (const b of buses) if (b.open()) n++; return n; };

/**
 * @param {string} url ws(s):// address of the server's /room endpoint
 * @returns {(channel:string)=>object} a makeBus factory for joinLocalRoom
 */
export function wsBus(url) {
  return (channel) => {
    let ws = null, closed = false, timer = null;
    const queue = [];
    const bus = {
      onmessage: null,
      postMessage(msg) {
        if (closed) return;
        const text = encode(msg);
        if (ws && ws.readyState === 1) ws.send(text);
        else if (queue.length < MAX_QUEUE) queue.push(text);
      },
      close() {
        closed = true;
        clearTimeout(timer);
        buses.delete(bus);
        if (ws) { try { ws.close(); } catch { /* already closed */ } }
      },
      open: () => !!ws && ws.readyState === 1,
    };
    const dial = () => {
      if (closed) return;
      ws = new WebSocket(`${url}?ch=${encodeURIComponent(channel)}`);
      ws.onopen = () => { while (queue.length && ws.readyState === 1) ws.send(queue.shift()); };
      ws.onmessage = (ev) => {
        if (closed || !bus.onmessage || typeof ev.data !== 'string') return;
        let data;
        try { data = decode(ev.data); } catch { return; }
        bus.onmessage({ data });
      };
      ws.onclose = () => { if (!closed) timer = setTimeout(dial, RECONNECT_MS); };
      ws.onerror = () => { /* onclose follows and reconnects */ };
    };
    buses.add(bus);
    dial();
    return bus;
  };
}
