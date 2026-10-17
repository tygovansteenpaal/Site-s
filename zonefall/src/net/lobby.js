// ZONEFALL - matchmaking and pre-match lobby. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.7.
// Quick play: rooms `${NET.quickPrefix}-${region}-${n}` (region from the time zone), n = 1..NET.buckets. Each try waits
// NET.bucketProbeMs for 'hello' replies and hops to n + 1 if a peer reports st:'live' or the room already holds
// MATCH.maxHumans humans. Private: a NET.codeLength code from NET.codeAlphabet, room `${NET.privatePrefix}-${code}`,
// password = code. Every peer says 'hello' on join and every 2 s (in a match too, with st:'live'). The lobby host
// (net/session: the peer that joined the room first) runs the countdown (MATCH.lobbyCountdown at >= 2 humans,
// MATCH.lobbyCountdownFull at >= 6, quick play alone: bots after MATCH.aloneStartAfter), broadcasts 'lobby' every
// second and calls game/match.hostBegin(humans) at zero. Non-hosts mirror the countdown from 'lobby'.
// The roster only holds peers in the lobby context (session.contextPeers): players still in a match are never pulled
// into the next one. While some are, a private lobby waits for them (START NOW overrides); quick play carries on.
import { NET, MATCH } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, APP } from '../core/state.js';
import { PROTOCOL_VERSION, ACTIONS } from './protocol.js';
import * as session from './session.js';
import * as sync from './sync.js';
import * as match from '../game/match.js';

export const TUNE = {
  helloEveryMs: 2000,
  helloFreshMs: 6000,        // a 'live' hello older than this no longer counts as a match in progress
  lobbyEveryMs: 1000,
  emitEveryMs: 250,          // LOBBY_UPDATE cadence while something is ticking (plus on every change)
  joinProbeMs: 2500,         // private join: how long to listen for hellos before deciding the room is not full
  minLeadMs: 10000,          // a human who joins during a countdown always gets at least this long before the drop
  settleMs: 1200,            // after connecting, listen this long before acting as host (avoids a double countdown)
  maxHumans: MATCH.maxHumans, // humans per room; overridable in tests through debug.net.lobby.TUNE
};

const SA_ZONES = /^America\/(Sao_Paulo|Argentina|Buenos_Aires|Cordoba|Mendoza|Bogota|Lima|Santiago|Caracas|La_Paz|Montevideo|Asuncion|Guayaquil|Cayenne|Paramaribo|Guyana|Recife|Fortaleza|Belem|Manaus|Cuiaba|Porto_Velho|Rio_Branco|Boa_Vista|Maceio|Bahia|Araguaina|Santarem|Campo_Grande|Noronha|Punta_Arenas|Eirunepe)/;

/** Matchmaking region from an IANA time zone (exported for tests): eu | na | sa | as | oc | af. */
export function regionFromTimeZone(tz, offsetMin = 0) {
  const z = String(tz || '');
  if (/^(Europe|Atlantic)\//.test(z)) return 'eu';
  if (/^Africa\//.test(z)) return 'af';
  if (SA_ZONES.test(z) || /^(Brazil|Chile)\//.test(z) || /^Antarctica\/Palmer/.test(z)) return 'sa';
  if (/^(America|US|Canada|Mexico)\//.test(z)) return 'na';
  if (/^(Asia|Indian)\//.test(z)) return 'as';
  if (/^(Australia|Pacific|NZ)/.test(z)) return 'oc';
  const h = -offsetMin / 60;                  // getTimezoneOffset sign is inverted
  if (h <= -3.5) return 'na';
  if (h <= 3.5) return 'eu';
  if (h <= 9.5) return 'as';
  return 'oc';
}

function localRegion() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = ''; }
  return regionFromTimeZone(tz, new Date().getTimezoneOffset());
}

/** A random private lobby code (crypto, unbiased). */
export function generateCode() {
  const A = NET.codeAlphabet, n = A.length, limit = 256 - (256 % n);
  let out = '';
  const buf = new Uint8Array(16);
  while (out.length < NET.codeLength) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < NET.codeLength; i++) if (buf[i] < limit) out += A[buf[i] % n];
  }
  return out;
}

/** Normalise user input to a code ('k7q-2m ' -> 'K7Q2M'), or null if it cannot be one. */
export function normalizeCode(input) {
  const c = String(input == null ? '' : input).toUpperCase().replace(/[\s\-_.]/g, '');
  if (c.length !== NET.codeLength) return null;
  for (const ch of c) if (!NET.codeAlphabet.includes(ch)) return null;
  return c;
}

// ------------------------------------------------------------------------------------------------ module state
const L = {
  mode: 'quick', code: null, roomId: null, status: 'waiting', text: 'Not connected', hostId: null, isHost: false,
  roster: [], countdownEndsAt: null, link: null, region: null, bucket: 0, humans: 0, matchInProgress: false,
};
const infos = new Map();       // peer id -> {name, st, mid, hum, at}
let token = 0;                 // bumps on leave / new search, cancels pending async flows
let phase = 'idle';            // 'idle' | 'connecting' | 'probing' | 'settled'
let settledAt = 0;
let aloneSince = 0;
let started = false;
let forced = false;
let nextHelloAt = 0, nextLobbyAt = 0, nextEmitAt = 0;
let lastHostLobby = null;      // {cd, at, ro, mode, from}
let lastEmitKey = '';
let inited = false;

function now() { return performance.now(); }

function helloPayload() {
  const live = (state.app === APP.MATCH || state.app === APP.RESULTS) && state.match.phase !== 'idle' && state.match.phase !== 'ended';
  return { v: PROTOCOL_VERSION, name: state.name || 'Operator', st: live ? 'live' : 'lobby', mid: state.match.id || null, hum: session.contextPeers().length + 1, js: session.joinedAt(), hr: sync.heardPeers(), rs: state.app === APP.RESULTS };
}

function sayHello(target = null) {
  if (!state.online) return;
  session.send(ACTIONS.HELLO, helloPayload(), target);
}

export function init() {
  if (inited) return;
  inited = true;
  on(EV.NET_HELLO, ({ from, data }) => {
    const prev = infos.get(from);
    infos.set(from, { name: data.name, st: data.st, mid: data.mid, hum: data.hum, js: data.js, at: now() });
    if (!prev && state.app === APP.LOBBY) refresh(true);
  });
  on(EV.PEER_JOIN, ({ id }) => {
    sayHello(id);   // in a match too: a quick-play searcher must learn that this room is live
    if (state.app === APP.LOBBY && session.isHost() && L.countdownEndsAt != null && !started) {
      L.countdownEndsAt = Math.max(L.countdownEndsAt, now() + TUNE.minLeadMs);
    }
    if (state.app === APP.LOBBY) refresh(true);
  });
  on(EV.PEER_LEAVE, ({ id }) => {
    infos.delete(id);
    if (state.app === APP.LOBBY) refresh(true);
  });
  on(EV.NET_LOBBY, ({ from, data }) => {
    const host = session.hostId();
    const handover = session.isHost() && data.ep >= session.epoch() && from !== host && L.countdownEndsAt == null;
    if (from !== host && !handover) return;
    lastHostLobby = { cd: data.cd, at: now(), ro: data.ro, mode: data.mode, from };
    if (handover && data.cd != null && phase === 'settled' && !started) L.countdownEndsAt = now() + data.cd;
    if (state.app === APP.LOBBY) refresh(true);
  });
  on(EV.NET_START, ({ from, data }) => {
    if (state.app !== APP.LOBBY && state.app !== APP.RESULTS) return;   // playing another match: not for us
    if (from !== session.hostId()) return;
    if (!data.ro.some((r) => r.id === state.selfId)) {
      // The host started with a full roster that does not include us (joined in the same instant as others):
      // mark everyone it deployed as live, so we wait for the next round instead of showing a countdown.
      for (const r of data.ro) {
        const info = infos.get(r.id);
        if (info) { info.st = 'live'; info.mid = data.mid; }
      }
      lastHostLobby = null;
      L.countdownEndsAt = null;
      L.matchInProgress = true;
      setStatus('waiting', `This round is full (${TUNE.maxHumans} players). You deploy in the next one.`);
      return;
    }
    started = true;
    setStatus('starting', 'Deploying');
  });
  on(EV.HOST_CHANGED, ({ self }) => {
    if (self) aloneSince = now();      // a new host's alone timer starts when it takes over, never in the past
    if (self && lastHostLobby && lastHostLobby.cd != null && state.app === APP.LOBBY && !started) {
      // Migration during a countdown: keep the drop time everyone already sees.
      L.countdownEndsAt = lastHostLobby.at + lastHostLobby.cd;
    }
    if (state.app === APP.LOBBY) refresh(true);
  });
  on(EV.NET_STATUS, ({ status, text }) => {
    if (status === 'error' && phase !== 'idle') { setStatus('error', `${text}. Check your connection or play a practice match.`); }
  });
  on(EV.APP_STATE, ({ from, to }) => {
    if (to !== APP.LOBBY) return;
    if (from === APP.MATCH || from === APP.RESULTS) {
      // Back from a round: a fresh countdown, everyone re-announces.
      started = false; forced = false; L.countdownEndsAt = null; lastHostLobby = null;
      aloneSince = now(); settledAt = now() - TUNE.settleMs;
      nextHelloAt = 0;
      sayHello();
      refresh(true);
    }
  });
  debug.net = Object.assign(debug.net || {}, { lobby: { get, TUNE, regionFromTimeZone, generateCode, normalizeCode } });
}

// ------------------------------------------------------------------------------------------------ status
function setStatus(status, text) {
  L.status = status;
  L.text = text;
  refresh(true);
}

function shareLink(code) {
  try {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    if (/\/dev\/[^/]*$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/dev\/[^/]*$/, '/');
    u.pathname = u.pathname.replace(/index\.html$/, '');
    u.searchParams.set('room', code);
    return u.toString();
  } catch { return `?room=${code}`; }
}

function buildRoster() {
  const self = state.selfId;
  const host = session.hostId();
  // contextPeers() is already in lobby-host order (join time, then id); self slots in by the same rule
  const peersInLobby = session.contextPeers();
  const mine = session.joinedAt() || Infinity;
  const at = (id) => (id === self ? mine : infos.get(id)?.js || Infinity);
  const ordered = [];
  let placed = false;
  for (const id of peersInLobby) {
    if (!placed && (mine < at(id) || (mine === at(id) && self < id))) { ordered.push(self); placed = true; }
    ordered.push(id);
  }
  if (!placed) ordered.push(self);
  if (host && ordered.includes(host)) { ordered.splice(ordered.indexOf(host), 1); ordered.unshift(host); }
  let list = ordered;
  if (!session.isHost() && lastHostLobby && now() - lastHostLobby.at < 4000) {
    // the host's order is authoritative; append anyone it has not listed yet
    const seen = new Set();
    list = [];
    for (const r of lastHostLobby.ro) if (ordered.includes(r.id) && !seen.has(r.id)) { seen.add(r.id); list.push(r.id); }
    for (const id of ordered) if (!seen.has(id)) list.push(id);
  }
  return list.slice(0, TUNE.maxHumans).map((id) => ({
    id,
    name: id === self ? (state.name || 'Operator') : (infos.get(id)?.name || lastHostLobby?.ro.find((r) => r.id === id)?.name || 'Joining'),
    self: id === self,
    host: id === host,
  }));
}

/** Some connected player is in a match right now (its snapshots carry a match tag, or a recent hello says 'live'). */
function liveElsewhere() {
  if (session.peersInMatch().length) return true;
  const ids = new Set(session.peers());
  const t = now();
  for (const [id, info] of infos) if (ids.has(id) && info.st === 'live' && t - info.at < TUNE.helloFreshMs && !session.contextPeers().includes(id)) return true;
  return false;
}

/** A private lobby waits for its players still in a match; quick play and START NOW do not. */
function waitForLive(live) { return live && L.mode === 'private' && !forced; }

function refresh(force) {
  L.hostId = session.hostId();
  L.isHost = session.isHost() && state.online;
  L.roster = state.online ? buildRoster() : [];
  L.humans = L.roster.length;
  L.matchInProgress = state.online && liveElsewhere();
  const key = `${L.status}|${L.text}|${L.hostId}|${L.countdownEndsAt}|${L.roster.map((r) => r.id + r.name).join(',')}|${L.matchInProgress}`;
  const t = now();
  if (key !== lastEmitKey || (force && t >= nextEmitAt) || (L.countdownEndsAt != null && t >= nextEmitAt)) {
    lastEmitKey = key;
    nextEmitAt = t + TUNE.emitEveryMs;
    emit(EV.LOBBY_UPDATE, { lobby: get() });
  }
}

// ------------------------------------------------------------------------------------------------ flows
async function probe(ms, myToken, stopEarly) {
  const end = now() + ms;
  while (now() < end) {
    if (myToken !== token) return false;
    if (stopEarly && stopEarly()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return myToken === token;
}

function full() { return session.peers().length + 1 > TUNE.maxHumans; }

/**
 * Seat check against the host's last 'lobby' roster, which is authoritative (join order as the host saw it), so two
 * players who arrive in the same instant at a 9-player room do not both bounce: only the one the host left out does.
 * Returns null while there is no definite answer (no recent host roster, or one that predates our arrival); callers
 * then fall back to counting peers.
 */
function hostSaysFull() {
  const hl = lastHostLobby;
  if (!hl || session.isHost() || hl.from !== session.hostId() || now() - hl.at > 4000) return null;
  if (hl.ro.some((r) => r.id === state.selfId)) return false;
  return hl.ro.length >= TUNE.maxHumans ? true : null;   // not listed yet but room left: the host has not seen us yet
}

/** Early exit while probing: only definite answers (a live match, or the host's roster is full without us). */
function busyEarly() { return liveElsewhere() || hostSaysFull() === true; }

/** Final decision after probing. */
function busy() { return liveElsewhere() || (hostSaysFull() ?? full()); }

function settle() {
  phase = 'settled';
  settledAt = now();
  aloneSince = now();
  started = false; forced = false;
  L.countdownEndsAt = null;
  nextHelloAt = 0; nextLobbyAt = 0;
  sayHello();
  setStatus('waiting', waitingText());
}

async function connectOrFail(roomId, password, myToken) {
  try {
    await session.connect({ roomId, password });
    return myToken === token;
  } catch (err) {
    if (myToken !== token) return false;
    phase = 'idle';
    setStatus('error', `${String(err && err.message || err).replace(/\s*\(.*\)$/, '')}. Check your connection or play a practice match.`);
    return false;
  }
}

function resetFor(mode, code) {
  const myToken = ++token;
  if (state.online) session.leave();
  infos.clear();
  lastHostLobby = null;
  started = false; forced = false;
  L.mode = mode; L.code = code; L.link = code ? shareLink(code) : null; L.countdownEndsAt = null;
  phase = 'connecting';
  return myToken;
}

/** Find or open a public lobby. Resolves when joined (state.app should already be 'lobby'). */
export async function quickPlay() {
  const myToken = resetFor('quick', null);
  L.region = localRegion();
  for (let n = 1; n <= NET.buckets; n++) {
    L.bucket = n;
    L.roomId = `${NET.quickPrefix}-${L.region}-${n}`;
    phase = 'connecting';
    setStatus('connecting', n === 1 ? 'Connecting to matchmaking' : `Lobby ${n - 1} is in a match. Trying lobby ${n}`);
    if (!(await connectOrFail(L.roomId, null, myToken))) return;
    phase = 'probing';
    setStatus('connecting', `Searching ${L.region.toUpperCase()} lobby ${n}`);
    if (!(await probe(NET.bucketProbeMs, myToken, busyEarly))) return;
    if (!busy()) { settle(); return; }
    session.leave();
    infos.clear();
  }
  phase = 'idle';
  setStatus('error', 'Every public lobby is busy right now. Create a private lobby or try again in a minute.');
}

/** Open a private lobby; resolves to its code. */
export async function createPrivate() {
  const code = generateCode();
  const myToken = resetFor('private', code);
  L.roomId = `${NET.privatePrefix}-${code}`;
  setStatus('connecting', 'Opening a private lobby');
  if (!(await connectOrFail(L.roomId, code, myToken))) return code;
  settle();
  return code;
}

/** Join a private lobby by code (case-insensitive, validated against NET.codeAlphabet). */
export async function joinPrivate(input) {
  const code = normalizeCode(input);
  if (!code) throw new Error(`"${String(input ?? '').slice(0, 12)}" is not a lobby code. Codes have ${NET.codeLength} letters and digits, like K7Q2M.`);
  const myToken = resetFor('private', code);
  L.roomId = `${NET.privatePrefix}-${code}`;
  setStatus('connecting', `Joining lobby ${code}`);
  if (!(await connectOrFail(L.roomId, code, myToken))) return;
  phase = 'probing';
  const heardEveryone = () => session.peers().length > 0 && infos.size >= session.peers().length
    && (session.isHost() || hostSaysFull() !== null || liveElsewhere());
  if (!(await probe(TUNE.joinProbeMs, myToken, heardEveryone))) return;
  if (hostSaysFull() ?? full()) {
    leave();
    throw new Error(`Lobby ${code} is full (${TUNE.maxHumans} players).`);
  }
  settle();
}

/** Leave the lobby and the room. */
export function leave() {
  token++;
  phase = 'idle';
  started = false; forced = false;
  if (state.online) session.leave();
  infos.clear();
  lastHostLobby = null;
  L.code = null; L.link = null; L.roomId = null; L.countdownEndsAt = null; L.bucket = 0;
  setStatus('waiting', 'Not connected');
}

/** Host only: start now (empty slots filled with bots). Non-hosts: no-op returning false. */
export function requestStart() {
  if (!state.online || !session.isHost() || phase !== 'settled' || started) return false;
  forced = true;
  L.countdownEndsAt = now();
  refresh(true);
  return true;
}

function waitingText() {
  if (L.matchInProgress && L.mode === 'private') return 'A match is in progress. You deploy in the next round.';
  if (L.humans <= 1) return L.mode === 'private' ? 'Share the code to invite your squad' : 'Waiting for players';
  return 'Waiting for players';
}

/** Countdown, heartbeats, LOBBY_UPDATE emission. Called every frame while online (outside the lobby: heartbeat only). */
export function update(dt) {
  if (!state.online || phase === 'idle') { return; }
  const t = now();
  if (t >= nextHelloAt) { nextHelloAt = t + TUNE.helloEveryMs; sayHello(); }
  if (state.app !== APP.LOBBY) return;
  if (phase !== 'settled') { refresh(false); return; }

  const isHost = session.isHost();
  const humans = buildRoster();
  const live = liveElsewhere();
  if (started) { refresh(false); return; }

  if (isHost && t - settledAt >= TUNE.settleMs) {
    hostTick(t, humans, live);
    if (started) { refresh(false); return; }
  } else if (!isHost) {
    if (lastHostLobby && lastHostLobby.from === session.hostId()) {
      L.countdownEndsAt = lastHostLobby.cd == null ? null : lastHostLobby.at + lastHostLobby.cd - session.rtt(lastHostLobby.from) / 2;
    } else L.countdownEndsAt = null;
  }

  if (L.countdownEndsAt != null && !waitForLive(live)) {
    const alone = humans.length <= 1;
    L.status = 'countdown';
    L.text = alone && !forced ? 'No other players yet. Deploying with bots' : 'Match starting';
  } else {
    L.status = 'waiting';
    L.text = waitingText();
  }
  refresh(false);
}

function hostTick(t, humans, live) {
  const n = humans.length;
  if (forced) {
    // START NOW: countdownEndsAt already set to now
  } else if (waitForLive(live)) {
    L.countdownEndsAt = null;
    aloneSince = t;
  } else if (n >= MATCH.minHumansToCountdown) {
    const want = (n >= 6 ? MATCH.lobbyCountdownFull : MATCH.lobbyCountdown) * 1000;
    if (L.countdownEndsAt == null || L.countdownEndsAt - t > want) L.countdownEndsAt = t + want;
    aloneSince = t;
  } else if (L.mode === 'quick') {
    L.countdownEndsAt = aloneSince + MATCH.aloneStartAfter * 1000;
  } else {
    L.countdownEndsAt = null;
    aloneSince = t;
  }

  if (t >= nextLobbyAt) {
    nextLobbyAt = t + TUNE.lobbyEveryMs;
    session.send(ACTIONS.LOBBY, {
      ep: session.epoch(), cd: L.countdownEndsAt == null ? null : Math.max(0, L.countdownEndsAt - t),
      ro: humans.map((h) => ({ id: h.id, name: h.name })), mode: L.mode,
    });
  }

  if (L.countdownEndsAt != null && t >= L.countdownEndsAt) begin(humans);
}

function begin(humans) {
  started = true;
  session.send(ACTIONS.LOBBY, { ep: session.epoch(), cd: 0, ro: humans.map((h) => ({ id: h.id, name: h.name })), mode: L.mode });
  setStatus('starting', 'Deploying');
  try {
    match.hostBegin(humans.map((h) => ({ id: h.id, name: h.name })));
  } catch (err) {
    started = false;
    forced = false;
    L.countdownEndsAt = null;
    console.error('[NET/lobby] match.hostBegin failed', err);
    emit(EV.TOAST, { text: 'The match could not start. Try START NOW again.', kind: 'danger', ms: 5000 });
    setStatus('waiting', waitingText());
  }
}

/**
 * @returns {{mode:'quick'|'private', code:string|null, roomId:string|null, status:'connecting'|'waiting'|'countdown'|'starting'|'error',
 *   text:string, hostId:string|null, isHost:boolean, roster:Array<{id:string, name:string, self:boolean, host:boolean}>,
 *   countdownEndsAt:number|null, link:string|null, region:string|null, bucket:number, humans:number, matchInProgress:boolean}}
 *   countdownEndsAt in local performance.now() ms
 */
export function get() {
  return { ...L, roster: L.roster.map((r) => ({ ...r })) };
}
