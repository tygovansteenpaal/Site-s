// ZONEFALL - wire protocol. OWNER: NET (written complete by LEAD as the executable spec; ARCHITECTURE.md section 8).
// Pure module: no DOM, no Trystero, no THREE. Binary messages travel on the unreliable channel (or the reliable
// 'bin' fallback action); everything else is a reliable Trystero action with a JSON payload validated here.
// Protocol 2: every binary message carries a u32 match tag (matchTag(match id), 0 = lobby/menu/results) and every
// in-match reliable payload carries `mid`, so a peer still playing an older match (or already back in the lobby) can
// never leak positions, shots, hits, deaths, loot or grenades into another match that shares the room.
import { NET, WEAPON_ORDER } from '../config.js';

export const PROTOCOL_VERSION = NET.protocol;

/** First byte of every binary message. */
export const MSG = Object.freeze({ PSNAP: 1, BOTS: 2, SHOT: 3 });

/** Reliable action ids (<= 32 bytes each). */
export const ACTIONS = Object.freeze({
  HELLO: 'hello', LOBBY: 'lobby', START: 'start', HIT: 'hit', DEATH: 'death',
  PICK: 'pick', DROP: 'drop', NADE: 'nade', HOST: 'host', BIN: 'bin', LEAVE: 'leave', KICK: 'kick',
});

export const PSNAP_SIZE = 44;
export const BOT_HEADER = 16;
export const BOT_ENTRY = 24;
export const SHOT_SIZE = 48;
export const NONE = 255;

/**
 * 32-bit tag of a match id (FNV-1a), never 0: 0 on the wire means "not in a match" (menu, lobby, results).
 * @param {string|null} mid
 */
export function matchTag(mid) {
  if (!mid) return 0;
  let h = 0x811c9dc5;
  const s = String(mid);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h >>>= 0;
  return h === 0 ? 1 : h;
}

const weaponIndex = (id) => { const i = WEAPON_ORDER.indexOf(id); return i < 0 ? NONE : i; };
const weaponId = (i) => (i === NONE ? null : WEAPON_ORDER[i] || null);
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const u8 = (n) => Math.max(0, Math.min(255, Math.round(n || 0)));

/** Normalise Trystero/RTCDataChannel binary (ArrayBuffer or any view) to an ArrayBuffer. */
export function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

/** Message type of a binary buffer, or 0 if invalid. */
export function msgType(buf) {
  if (!buf || buf.byteLength < 1) return 0;
  return new DataView(buf).getUint8(0);
}

// ------------------------------------------------------------------------------------------------ PSNAP (44 B)
// 0 u8 type=1 | 1 u8 weapon | 2 u16 seq | 4 f64 t (sender performance.now ms) | 12 f32 x | 16 f32 y | 20 f32 z
// 24 f32 yaw | 28 f32 pitch | 32 u16 flags | 34 u8 hp | 35 u8 armor | 36 u8 life | 37..39 reserved (0) | 40 u32 match tag
export function encodePlayerSnap(s) {
  const b = new ArrayBuffer(PSNAP_SIZE), v = new DataView(b);
  v.setUint8(0, MSG.PSNAP);
  v.setUint8(1, weaponIndex(s.weapon));
  v.setUint16(2, s.seq & 0xffff, true);
  v.setFloat64(4, s.t, true);
  v.setFloat32(12, s.x, true); v.setFloat32(16, s.y, true); v.setFloat32(20, s.z, true);
  v.setFloat32(24, s.yaw, true); v.setFloat32(28, s.pitch, true);
  v.setUint16(32, s.flags & 0xffff, true);
  v.setUint8(34, u8(s.hp)); v.setUint8(35, u8(s.armor)); v.setUint8(36, u8(s.life));
  v.setUint32(40, (s.tag || 0) >>> 0, true);
  return b;
}

export function decodePlayerSnap(b) {
  if (!b || b.byteLength !== PSNAP_SIZE) return null;
  const v = new DataView(b);
  if (v.getUint8(0) !== MSG.PSNAP) return null;
  const s = {
    weapon: weaponId(v.getUint8(1)), seq: v.getUint16(2, true), t: v.getFloat64(4, true),
    x: v.getFloat32(12, true), y: v.getFloat32(16, true), z: v.getFloat32(20, true),
    yaw: v.getFloat32(24, true), pitch: v.getFloat32(28, true),
    flags: v.getUint16(32, true), hp: v.getUint8(34), armor: v.getUint8(35), life: v.getUint8(36), tag: v.getUint32(40, true),
  };
  return finite(s.t, s.x, s.y, s.z, s.yaw, s.pitch) ? s : null;
}

// ------------------------------------------------------------------------------------------------ BOTS (16 + 24 n B)
// header: 0 u8 type=2 | 1 u8 count | 2 u16 seq | 4 f64 t | 12 u32 match tag
// entry:  0 u8 slot | 1 u8 weapon | 2 u16 flags | 4 f32 x | 8 f32 y | 12 f32 z | 16 i16 yaw*1e4 | 18 i16 pitch*1e4
//         20 u8 hp | 21 u8 armor | 22 u8 life | 23 reserved
export function encodeBotBatch(t, seq, bots, tag = 0) {
  const n = Math.min(bots.length, 64);
  const b = new ArrayBuffer(BOT_HEADER + BOT_ENTRY * n), v = new DataView(b);
  v.setUint8(0, MSG.BOTS); v.setUint8(1, n); v.setUint16(2, seq & 0xffff, true); v.setFloat64(4, t, true);
  v.setUint32(12, (tag || 0) >>> 0, true);
  for (let i = 0; i < n; i++) {
    const e = bots[i], o = BOT_HEADER + i * BOT_ENTRY;
    v.setUint8(o, u8(e.slot)); v.setUint8(o + 1, weaponIndex(e.weapon)); v.setUint16(o + 2, e.flags & 0xffff, true);
    v.setFloat32(o + 4, e.x, true); v.setFloat32(o + 8, e.y, true); v.setFloat32(o + 12, e.z, true);
    v.setInt16(o + 16, Math.round(wrapPi(e.yaw) * 1e4), true);
    v.setInt16(o + 18, Math.round(Math.max(-1.57, Math.min(1.57, e.pitch)) * 1e4), true);
    v.setUint8(o + 20, u8(e.hp)); v.setUint8(o + 21, u8(e.armor)); v.setUint8(o + 22, u8(e.life));
  }
  return b;
}

export function decodeBotBatch(b) {
  if (!b || b.byteLength < BOT_HEADER) return null;
  const v = new DataView(b);
  if (v.getUint8(0) !== MSG.BOTS) return null;
  const n = v.getUint8(1);
  if (b.byteLength !== BOT_HEADER + n * BOT_ENTRY) return null;
  const out = { seq: v.getUint16(2, true), t: v.getFloat64(4, true), tag: v.getUint32(12, true), bots: [] };
  if (!finite(out.t)) return null;
  for (let i = 0; i < n; i++) {
    const o = BOT_HEADER + i * BOT_ENTRY;
    const e = {
      slot: v.getUint8(o), weapon: weaponId(v.getUint8(o + 1)), flags: v.getUint16(o + 2, true),
      x: v.getFloat32(o + 4, true), y: v.getFloat32(o + 8, true), z: v.getFloat32(o + 12, true),
      yaw: v.getInt16(o + 16, true) / 1e4, pitch: v.getInt16(o + 18, true) / 1e4,
      hp: v.getUint8(o + 20), armor: v.getUint8(o + 21), life: v.getUint8(o + 22),
    };
    if (finite(e.x, e.y, e.z)) out.bots.push(e);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ SHOT (48 B)
// 0 u8 type=3 | 1 u8 weapon | 2 u16 seq | 4 f64 t | 12 f32 ox | 16 f32 oy | 20 f32 oz | 24 f32 dx | 28 f32 dy | 32 f32 dz
// 36 f32 dist (to impact or range) | 40 u8 surface (255 none) | 41 u8 hitFlags (bit0 player, bit1 head, bit2 kill)
// 42 u8 botSlot (255 = the sender itself) | 43 reserved | 44 u32 match tag
export const SHOT_HIT = Object.freeze({ PLAYER: 1, HEAD: 2, KILL: 4 });

export function encodeShot(s) {
  const b = new ArrayBuffer(SHOT_SIZE), v = new DataView(b);
  v.setUint8(0, MSG.SHOT); v.setUint8(1, weaponIndex(s.weapon)); v.setUint16(2, s.seq & 0xffff, true);
  v.setFloat64(4, s.t, true);
  v.setFloat32(12, s.origin[0], true); v.setFloat32(16, s.origin[1], true); v.setFloat32(20, s.origin[2], true);
  v.setFloat32(24, s.dir[0], true); v.setFloat32(28, s.dir[1], true); v.setFloat32(32, s.dir[2], true);
  v.setFloat32(36, s.dist, true);
  v.setUint8(40, s.surface == null ? NONE : u8(s.surface));
  v.setUint8(41, s.hitFlags & 0xff);
  v.setUint8(42, s.botSlot == null ? NONE : u8(s.botSlot));
  v.setUint32(44, (s.tag || 0) >>> 0, true);
  return b;
}

export function decodeShot(b) {
  if (!b || b.byteLength !== SHOT_SIZE) return null;
  const v = new DataView(b);
  if (v.getUint8(0) !== MSG.SHOT) return null;
  const s = {
    weapon: weaponId(v.getUint8(1)), seq: v.getUint16(2, true), t: v.getFloat64(4, true),
    origin: [v.getFloat32(12, true), v.getFloat32(16, true), v.getFloat32(20, true)],
    dir: [v.getFloat32(24, true), v.getFloat32(28, true), v.getFloat32(32, true)],
    dist: v.getFloat32(36, true), surface: v.getUint8(40) === NONE ? null : v.getUint8(40),
    hitFlags: v.getUint8(41), botSlot: v.getUint8(42) === NONE ? null : v.getUint8(42), tag: v.getUint32(44, true),
  };
  return finite(s.t, s.dist, ...s.origin, ...s.dir) ? s : null;
}

/** 16-bit sequence comparison: true if a is newer than b (wrap-around safe). */
export const seqNewer = (a, b) => ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;

// ------------------------------------------------------------------------------------------------ reliable payloads
function finite(...xs) { for (const x of xs) if (typeof x !== 'number' || !Number.isFinite(x)) return false; return true; }
const str = (x, max) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null);
const vec3 = (a) => (Array.isArray(a) && a.length === 3 && finite(a[0], a[1], a[2]) ? [a[0], a[1], a[2]] : null);
const intIn = (x, lo, hi) => (Number.isInteger(x) && x >= lo && x <= hi ? x : null);
const numIn = (x, lo, hi) => (finite(x) && x >= lo && x <= hi ? x : null);
const cleanName = (x) => (typeof x === 'string' ? x.replace(/[^\w .\-]/g, '').trim().slice(0, 16) : '') || 'Player';
const WEAPON_IDS = new Set(WEAPON_ORDER);
const DEATH_CAUSES = new Set([...WEAPON_ORDER, 'zone', 'fall', 'left']);
const ITEM_TYPES = new Set(['weapon', 'ammo', 'plate', 'frag']);

/**
 * Validators: each returns a sanitized copy or null (drop the message).
 * Field glossary is in ARCHITECTURE.md 8.4.
 */
export const validate = Object.freeze({
  // {v, name, st: 'lobby'|'live', mid, hum, js: wall-clock ms this peer joined the room (lobby host = earliest),
  //  hr: ids of the players this peer heard in the last NET.staleMs (a player is only dropped when nobody hears him),
  //  rs: on the results screen (counts for the next round, but never hosts the lobby: it does not run the countdown)}
  hello(d) {
    if (!d || typeof d !== 'object') return null;
    const v = intIn(d.v, 0, 1000);
    if (v === null) return null;
    const hr = Array.isArray(d.hr) ? d.hr.slice(0, 16).map((x) => str(x, 40)).filter(Boolean) : [];
    return { v, name: cleanName(d.name), st: d.st === 'live' ? 'live' : 'lobby', mid: str(d.mid, 24), hum: intIn(d.hum, 0, 64) ?? 0, js: numIn(d.js, 0, 1e15) ?? 0, hr, rs: d.rs === true };
  },
  // {ep, cd: ms until start | null, ro: [{id, name}], mode}
  lobby(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.ro) || d.ro.length > 64) return null;
    const ep = intIn(d.ep, 0, 1e9);
    if (ep === null) return null;
    const ro = [];
    for (const r of d.ro) { const id = str(r && r.id, 40); if (id) ro.push({ id, name: cleanName(r.name) }); }
    return { ep, cd: d.cd == null ? null : numIn(d.cd, 0, 600000), ro, mode: d.mode === 'private' ? 'private' : 'quick' };
  },
  // {mid, seed, t0h, th, ro: [{id, name, kind: 'h'|'b', slot}], ep}
  start(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.ro) || d.ro.length < 1 || d.ro.length > 64) return null;
    const mid = str(d.mid, 24), seed = intIn(d.seed, 0, 0xffffffff), t0h = numIn(d.t0h, -1e12, 1e12), th = numIn(d.th, -1e12, 1e12);
    const ep = intIn(d.ep, 0, 1e9);
    if (!mid || seed === null || t0h === null || th === null || ep === null) return null;
    const ro = [], slots = new Set();
    for (const r of d.ro) {
      const id = str(r && r.id, 40), slot = intIn(r && r.slot, 0, 63);
      if (!id || slot === null || slots.has(slot)) return null;
      slots.add(slot);
      ro.push({ id, name: cleanName(r.name), kind: r.kind === 'b' ? 'bot' : 'human', slot });
    }
    return { mid, seed, t0h, th, ro, ep };
  },
  // {mid, sid, by, tgt, w, z: 0 body | 1 head | 2 limb, dmg, d, sp, tp, t}
  hit(d) {
    if (!d || typeof d !== 'object') return null;
    const out = {
      mid: str(d.mid, 24), sid: intIn(d.sid, 0, 0x7fffffff), by: str(d.by, 40), tgt: str(d.tgt, 40), w: WEAPON_IDS.has(d.w) ? d.w : null,
      z: intIn(d.z, 0, 2), dmg: numIn(d.dmg, 0, 400), d: numIn(d.d, 0, 2000), sp: vec3(d.sp), tp: vec3(d.tp), t: numIn(d.t, -1e9, 1e9),
    };
    for (const k in out) if (out[k] === null) return null;
    return out;
  },
  // {mid, id, by|null, w: weapon|'zone'|'fall'|'left', hs, sid|null, pos}
  death(d) {
    if (!d || typeof d !== 'object') return null;
    const mid = str(d.mid, 24), id = str(d.id, 40), pos = vec3(d.pos), w = DEATH_CAUSES.has(d.w) ? d.w : null;
    if (!mid || !id || !pos || !w) return null;
    return { mid, id, by: d.by == null ? null : str(d.by, 40), w, hs: !!d.hs, sid: d.sid == null ? null : intIn(d.sid, 0, 0x7fffffff), pos };
  },
  // {mid, uid, t: match ms, by: bot id | null}
  pick(d) {
    if (!d || typeof d !== 'object') return null;
    const mid = str(d.mid, 24), uid = str(d.uid, 32), t = numIn(d.t, -1e9, 1e9);
    if (!mid || !uid || t === null) return null;
    return { mid, uid, t, by: d.by == null ? null : str(d.by, 40) };
  },
  // {mid, items: [{uid, type, ref, qty, pos}]}
  drop(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.items) || d.items.length > 16) return null;
    const mid = str(d.mid, 24);
    if (!mid) return null;
    const items = [];
    for (const it of d.items) {
      const uid = str(it && it.uid, 32), pos = vec3(it && it.pos), qty = intIn(it && it.qty, 0, 1000);
      if (!uid || !pos || qty === null || !ITEM_TYPES.has(it.type)) return null;
      items.push({ uid, type: it.type, ref: it.ref == null ? null : str(it.ref, 16), qty, pos });
    }
    return { mid, items };
  },
  // {mid, gid, by, o, v, fuse, t}
  nade(d) {
    if (!d || typeof d !== 'object') return null;
    const out = { mid: str(d.mid, 24), gid: str(d.gid, 48), by: str(d.by, 40), o: vec3(d.o), v: vec3(d.v), fuse: numIn(d.fuse, 0, 10), t: numIn(d.t, -1e9, 1e9) };
    for (const k in out) if (out[k] === null) return null;
    return out;
  },
  // {ep, id, mid: match id the term belongs to | null for the lobby}
  host(d) {
    if (!d || typeof d !== 'object') return null;
    const ep = intIn(d.ep, 0, 1e9), id = str(d.id, 40);
    return ep === null || !id ? null : { ep, id, mid: d.mid == null ? null : str(d.mid, 24) };
  },
  // {mid, alive}: the sender left match mid (LEAVE MATCH, main menu); alive = it was still alive (a forfeit)
  leave(d) {
    if (!d || typeof d !== 'object') return null;
    const mid = str(d.mid, 24);
    return mid ? { mid, alive: !!d.alive } : null;
  },
  // {mid}: the sender dropped the receiver from match mid after a long silence; the receiver forfeits it
  kick(d) {
    if (!d || typeof d !== 'object') return null;
    const mid = str(d.mid, 24);
    return mid ? { mid } : null;
  },
});

/** Hit zone codes used in 'hit'. */
export const ZONE_CODE = Object.freeze({ body: 0, head: 1, limb: 2 });
export const ZONE_NAME = Object.freeze(['body', 'head', 'limb']);
