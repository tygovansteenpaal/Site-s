// ZONEFALL - matchmaking and pre-match lobby. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.7.
// Quick play: rooms `${NET.quickPrefix}-v${protocol}-gl-${n}`, n = 1..NET.buckets, shared by every region. The search
// never scatters people into separate bot matches: everyone probes the same buckets in the same order, listening
// NET.bucketProbeMs in each, so searchers converge. (Per-region buckets split people: a searcher who found his region's
// bucket empty moved on while two others met in it a moment later. One room at a time cannot watch two places, so
// quick play has one meeting order for the whole world; the region only labels the player.) Players waiting in a lobby
// are joined at once. A bucket whose match is live is remembered; at the first empty bucket the searcher either waits
// there (nobody is playing anywhere: the next searchers meet him there, bots after MATCH.aloneStartAfter) or, when
// humans are in a live match, joins that bucket's lobby and is told how many play and how long the round can last: he
// deploys with them in the next round, or plays now with bots (START NOW, labelled so). Two or more waiting humans do
// not wait for the live match: their countdown runs and the live players join the next round after. Private: a NET.codeLength code from NET.codeAlphabet, room `${NET.privatePrefix}-${code}`
// (no room password: the code is in the room id). Every peer says 'hello' on join and every 2 s (in a match too, with st:'live'). The lobby host
// (net/session: the peer that joined the room first) runs the countdown (MATCH.lobbyCountdown at >= 2 humans,
// MATCH.lobbyCountdownFull at >= 6, quick play alone: bots after MATCH.aloneStartAfter), broadcasts 'lobby' every
// second and calls game/match.hostBegin(humans) at zero. Non-hosts mirror the countdown from 'lobby'.
// The roster only holds peers in the lobby context (session.contextPeers): players still in a match are never pulled
// into the next one. While some are, a private lobby waits for them (START NOW overrides); quick play carries on.
// Quick-play room names carry the protocol version, so old and new clients never share (and empty) a bucket; private
// rooms do not, so a version mismatch is detected there and explained in the lobby.
// Connection failures: the lobby shows the error with a Retry button and retries by itself (5, 10, 20, then every
// 30 s); losing every relay while alone holds the alone countdown instead of starting a bot match.
// Private lobbies: the address bar carries ?room=CODE while in one (a refresh comes back to it, never to an old
// one); a code nobody is in says so once TUNE.nobodyAfterMs passes without a single player (a busy room's connections
// can take longer than the join probe, so until then it reads "Looking for players"); the creator (remembered per tab,
// so also after a refresh) hosts the lobby. A player arriving at a full lobby never sees a countdown he will not deploy
// in, and his arrival does not extend the countdown of the others.
import { NET, MATCH, ZONE } from '../config.js';
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
  retryMs: [5000, 10000, 20000, 30000],   // automatic reconnect attempts after a connection failure (last one repeats)
  unseatedHopMs: 4000,       // quick play: a full room that only showed it after we settled -> search the next bucket
  nobodyAfterMs: 10000,      // private join: no player seen this long after settling -> "nobody is in this lobby" (a
                             // busy room's connections can take several seconds to form, longer than the join probe)
  blockedAfterMs: 12000,     // after settling: nobody connected but players tried -> "your network blocks direct connections"
  globalNs: 'gl',            // quick play: the bucket namespace every region shares
};

/** Longest a round can last (s): the zone's whole timeline. A live match's time left is estimated from it. */
const ROUND_S = ZONE.startAt + ZONE.phases.reduce((t, p) => t + p.wait + p.shrink, 0);

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
  created: false, retryAt: null, seated: true,
  ns: null,             // quick play: the bucket namespace we are in (our region, or 'gl')
  live: null,           // a match in progress in this room: {humans, minLeft} (quick play offers to wait for it)
  inMatch: [],          // players of this room playing a match right now: [{id, name}] (listed apart from the roster)
  canStart: false,      // START NOW is offered (host, and not a lone player who joined a private room mid-match)
  startLabel: 'Start now',
  note: null,           // a connectivity explanation shown under the status text, or null
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
let lastFlow = null;           // {kind: 'quick'|'create'|'join', code}: what Retry runs again
let retryTimer = 0, retries = 0;
let unseatedSince = 0;
let everSeen = false;          // some player of this room connected (or said hello) since we joined it
let nobodyToasted = false;
let blockedToasted = false;

function now() { return performance.now(); }

function helloPayload() {
  // a player removed from his match (Disconnected screen) is not playing it any more: nobody should wait for him
  const m = state.match;
  const live = (state.app === APP.MATCH || state.app === APP.RESULTS) && m.phase !== 'idle' && m.phase !== 'ended' && !m.netLost;
  const links = session.directLinks();
  let mh = 0;
  if (live) for (const r of m.roster) if (r.kind === 'human') { const e = state.players.get(r.id); if (e && e.alive) mh++; }
  return {
    v: session.protocolVersion(), name: state.name || 'Operator', st: live ? 'live' : 'lobby', mid: m.id || null, hum: session.contextPeers().length + 1,
    js: session.joinedAt(), hr: sync.heardPeers(), rs: state.app === APP.RESULTS, ln: links.map((l) => l.id), lr: links.map((l) => l.rtt), lj: links.map((l) => l.js),
    mt: live ? Math.round(m.time) : null, mh: live ? mh : null,
  };
}

function sayHello(target = null) {
  if (!state.online) return;
  session.send(ACTIONS.HELLO, helloPayload(), target);
}

export function init() {
  if (inited) return;
  inited = true;
  // a connecting peer hears our hello at once (directly or through a relay): it carries the version check
  session.setGreeter((id) => sayHello(id));
  on(EV.NET_HELLO, ({ from, data }) => {
    everSeen = true;
    const prev = infos.get(from);
    infos.set(from, { name: data.name, st: data.st, mid: data.mid, hum: data.hum, js: data.js, mt: data.mt, mh: data.mh, at: now() });
    if (!prev && state.app === APP.LOBBY) refresh(true);
  });
  on(EV.PEER_JOIN, ({ id }) => {
    everSeen = true;
    sayHello(id);   // in a match too: a quick-play searcher must learn that this room is live
    // a newcomer who gets a seat gets time to load in; one arriving at a full lobby does not hold up the others
    if (state.app === APP.LOBBY && session.isHost() && L.countdownEndsAt != null && !started && buildRoster().some((r) => r.id === id)) {
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
  debug.net = Object.assign(debug.net || {}, { lobby: { get, TUNE, regionFromTimeZone, generateCode, normalizeCode, retry } });
}

// ------------------------------------------------------------------------------------------------ address bar, creator
/** Keep ?room=CODE in the address bar while in a private lobby (a refresh rejoins it), and only then. */
function setRoomParam(code) {
  try {
    const u = new URL(location.href);
    if ((u.searchParams.get('room') || null) === (code || null)) return;
    if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
    history.replaceState(history.state, '', u.toString());
  } catch { /* no history API (sandboxed frame) */ }
}

const CREATED_KEY = 'zonefall.created';
/** Codes this tab created (sessionStorage: survives a refresh, not shared with other tabs). */
function createdCodes() {
  try { const v = JSON.parse(sessionStorage.getItem(CREATED_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rememberCreated(code) {
  try { sessionStorage.setItem(CREATED_KEY, JSON.stringify([code, ...createdCodes().filter((c) => c !== code)].slice(0, 5))); } catch { /* storage blocked */ }
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
  const nameOf = (id) => (id === self ? (state.name || 'Operator') : (infos.get(id)?.name || lastHostLobby?.ro.find((r) => r.id === id)?.name || 'Joining'));
  return list.slice(0, TUNE.maxHumans).map((id) => {
    const route = id === self ? null : session.routeInfo(id);
    return { id, name: nameOf(id), self: id === self, host: id === host, via: route && route.route === 'relay' ? nameOf(route.via) : null };
  });
}

/** Some connected player is in a match right now (its snapshots carry a match tag, or a recent hello says 'live'). */
function liveElsewhere() {
  if (session.peersInMatch().length) return true;
  const ids = new Set(session.peers());
  const t = now();
  for (const [id, info] of infos) if (ids.has(id) && info.st === 'live' && t - info.at < TUNE.helloFreshMs && !session.contextPeers().includes(id)) return true;
  return false;
}

/** Players of this room in a match right now (not in our lobby): [{id, name, mid, mt}] from their latest hellos. */
function playersInMatch() {
  const ids = new Set(session.peers());
  const lobbyIds = new Set(session.contextPeers());
  const tagged = new Set(session.peersInMatch());
  const t = now();
  const out = [];
  for (const [id, info] of infos) {
    if (!ids.has(id) || lobbyIds.has(id)) continue;
    if (!tagged.has(id) && !(info.st === 'live' && t - info.at < TUNE.helloFreshMs)) continue;
    out.push({ id, name: info.name, mid: info.mid, mt: info.mt });
  }
  return out;
}

/** The biggest match in progress in this room: {humans, minLeft} (time left estimated from the zone timeline), or null. */
function liveHere() {
  const byMid = new Map();
  for (const p of playersInMatch()) {
    const k = p.mid || '?';
    const g = byMid.get(k) || { humans: 0, mt: 0 };
    g.humans++;
    if (Number.isFinite(p.mt)) g.mt = Math.max(g.mt, p.mt);
    byMid.set(k, g);
  }
  let best = null;
  for (const g of byMid.values()) if (!best || g.humans > best.humans || (g.humans === best.humans && g.mt > best.mt)) best = g;
  return best ? { humans: best.humans, minLeft: Math.max(1, Math.ceil((ROUND_S - best.mt) / 60)) } : null;
}

/**
 * Wait for the players of this room who are in a match instead of counting down: a private lobby always does (START
 * NOW overrides); in quick play a lone player does (he deploys with them in the next round, or presses Play now with
 * bots), while two or more waiting humans go ahead together and the live players join the round after.
 */
function waitForLive(live, n = L.humans) {
  if (!live || forced) return false;
  return L.mode === 'private' || n <= 1;
}

function refresh(force) {
  L.hostId = session.hostId();
  L.isHost = session.isHost() && state.online;
  L.roster = state.online ? buildRoster() : [];
  L.humans = L.roster.length;
  L.matchInProgress = state.online && liveElsewhere();
  L.live = L.matchInProgress ? liveHere() : null;
  L.inMatch = state.online ? playersInMatch().map((p) => ({ id: p.id, name: p.name })) : [];
  L.canStart = L.isHost && startAllowed();
  L.startLabel = L.mode === 'quick' && L.matchInProgress && L.humans <= 1 ? 'Play now with bots' : 'Start now';
  L.note = state.online ? noteText() : null;
  const key = `${L.status}|${L.text}|${L.hostId}|${L.countdownEndsAt}|${L.roster.map((r) => r.id + r.name + (r.via || '')).join(',')}|${L.matchInProgress}|${L.retryAt}|${L.seated}|${L.inMatch.map((r) => r.id).join(',')}|${L.canStart}|${L.startLabel}|${L.note}|${L.live ? L.live.humans + ':' + L.live.minLeft : ''}`;
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

/**
 * Humans waiting in this room's lobby (its menu, lobby or results screen), not counting us. Only peers whose hello says
 * so: a peer counts in the lobby context until its first snapshot shows its match tag, and a quick-play probe must not
 * mistake a player of a live match for one waiting in the lobby during that instant.
 */
function lobbyHere() {
  let n = 0;
  for (const id of session.contextPeers()) { const info = infos.get(id); if (info && info.st === 'lobby') n++; }
  return n;
}

function settle() {
  phase = 'settled';
  retries = 0;
  settledAt = now();
  aloneSince = now();
  started = false; forced = false;
  L.countdownEndsAt = null;
  nextHelloAt = 0; nextLobbyAt = 0;
  sayHello();
  setStatus('waiting', waitingText());
}

async function connectOrFail(roomId, myToken, opts = {}) {
  try {
    await session.connect({ roomId, joiner: !!opts.joiner });
    return myToken === token;
  } catch (err) {
    if (myToken !== token) return false;
    phase = 'idle';
    setStatus('error', `${String(err && err.message || err).replace(/\s*\(.*\)$/, '')}. Check your connection or play a practice match.`);
    scheduleRetry(myToken);
    return false;
  }
}

/** After a connection failure: try the same flow again by itself, later and later (Retry in the lobby does it now). */
function scheduleRetry(myToken) {
  clearTimeout(retryTimer);
  if (!lastFlow) return;
  const delay = TUNE.retryMs[Math.min(retries, TUNE.retryMs.length - 1)];
  retries++;
  L.retryAt = now() + delay;
  refresh(true);
  retryTimer = setTimeout(() => { if (myToken === token && L.status === 'error') retry(); }, delay);
}

/** Run the last flow again (quick play, the same private code). Returns false when there is nothing to retry. */
export function retry() {
  const f = lastFlow;
  if (!f) return false;
  clearTimeout(retryTimer);
  L.retryAt = null;
  const run = f.kind === 'quick' ? quickPlay() : f.kind === 'create' ? createPrivate(f.code) : joinPrivate(f.code);
  run.catch((err) => {
    emit(EV.TOAST, { text: String(err && err.message || err), kind: 'danger', ms: 5000 });
    setStatus('error', String(err && err.message || err));
  });
  return true;
}

function resetFor(mode, code) {
  const myToken = ++token;
  clearTimeout(retryTimer);
  L.retryAt = null;
  if (state.online) session.leave();
  infos.clear();
  lastHostLobby = null;
  started = false; forced = false;
  unseatedSince = 0;
  everSeen = false; nobodyToasted = false; blockedToasted = false;
  L.mode = mode; L.code = code; L.link = code ? shareLink(code) : null; L.countdownEndsAt = null; L.created = false; L.seated = true;
  setRoomParam(code);
  phase = 'connecting';
  return myToken;
}

function quickRoom(ns, n) { return `${NET.quickPrefix}-v${PROTOCOL_VERSION}-${ns}-${n}`; }

/**
 * Connect to one quick-play bucket and listen NET.bucketProbeMs (ending early once players are seen waiting). Returns
 * {kind: 'waiting'|'live'|'full'|'empty', live} and stays connected, or null when cancelled or the connection failed.
 */
async function probeBucket(ns, n, myToken, label) {
  L.ns = ns; L.bucket = n; L.roomId = quickRoom(ns, n);
  phase = 'connecting';
  setStatus('connecting', label);
  if (!(await connectOrFail(L.roomId, myToken))) return null;
  phase = 'probing';
  setStatus('connecting', label);
  if (!(await probe(NET.bucketProbeMs, myToken, () => lobbyHere() > 0 || hostSaysFull() === true))) return null;
  const live = liveHere();
  const isFull = hostSaysFull() ?? full();
  const kind = isFull ? 'full' : lobbyHere() > 0 ? 'waiting' : live ? 'live' : 'empty';
  return { ns, n, kind, live };
}

function leaveBucket() { session.leave(); infos.clear(); lastHostLobby = null; }

/**
 * Find a public lobby (see the header). Resolves once settled in one (state.app should already be 'lobby').
 * opts.playNow: skip buckets with a match in progress (the player chose to play now with bots).
 */
export async function quickPlay(opts = {}) {
  const myToken = resetFor('quick', null);
  lastFlow = { kind: 'quick' };
  L.region = localRegion();
  const G = TUNE.globalNs;
  const lives = [];
  for (let n = 1; n <= NET.buckets; n++) {
    const ns = G;
    const label = n === 1 ? 'Searching for players' : `Searching lobby ${n}`;
    const r = await probeBucket(ns, n, myToken, label);
    if (!r) return;
    if (r.kind === 'waiting' && !(opts.playNow && r.live)) { settle(); return; }
    if (r.kind === 'live' || r.kind === 'waiting') { if (r.live) lives.push(r); leaveBucket(); continue; }
    if (r.kind === 'full') { leaveBucket(); continue; }
    // the first empty bucket: wait here (others searching meet us here), unless humans are playing somewhere
    if (!lives.length || opts.playNow) { settle(); return; }
    leaveBucket();
    const best = lives.sort((x, y) => y.live.humans - x.live.humans || x.live.minLeft - y.live.minLeft)[0];
    const again = await probeBucket(best.ns, best.n, myToken, 'Joining the lobby of the match in progress');
    if (!again) return;
    if (again.kind === 'full') { leaveBucket(); continue; }
    settle();
    const lv = liveHere() || best.live;
    emit(EV.TOAST, { text: `${lv.humans} ${lv.humans === 1 ? 'player is' : 'players are'} in a match in this lobby. You deploy together in the next round, or play now with bots.`, kind: 'info', ms: 7000 });
    return;
  }
  phase = 'idle';
  setStatus('error', 'Every public lobby is busy right now. Create a private lobby or try again in a minute.');
}

/** Open a private lobby (a new code, or `code` again when retrying); resolves to its code. */
export async function createPrivate(code = null) {
  code = normalizeCode(code) || generateCode();
  const myToken = resetFor('private', code);
  L.created = true;
  rememberCreated(code);
  lastFlow = { kind: 'create', code };
  L.roomId = `${NET.privatePrefix}-${code}`;
  setStatus('connecting', 'Opening a private lobby');
  if (!(await connectOrFail(L.roomId, myToken))) return code;
  settle();
  return code;
}

/** Join a private lobby by code (case-insensitive, validated against NET.codeAlphabet). */
export async function joinPrivate(input) {
  const code = normalizeCode(input);
  if (!code) throw new Error(`"${String(input ?? '').slice(0, 12)}" is not a lobby code. Codes have ${NET.codeLength} letters and digits, like K7Q2M.`);
  const myToken = resetFor('private', code);
  // this tab created the code (and came back, e.g. after a refresh): it keeps the lobby host role
  const creator = createdCodes().includes(code);
  L.created = creator;
  lastFlow = { kind: 'join', code };
  L.roomId = `${NET.privatePrefix}-${code}`;
  setStatus('connecting', `Joining lobby ${code}`);
  if (!(await connectOrFail(L.roomId, myToken, { joiner: !creator }))) return;
  phase = 'probing';
  const heardEveryone = () => session.peers().length > 0 && infos.size >= session.peers().length
    && (session.isHost() || hostSaysFull() !== null || liveElsewhere());
  if (!(await probe(TUNE.joinProbeMs, myToken, heardEveryone))) return;
  if (hostSaysFull() ?? full()) {
    leave();
    throw new Error(`Lobby ${code} is full (${TUNE.maxHumans} players).`);
  }
  settle();   // nobody here yet: update() says so once TUNE.nobodyAfterMs passes without a single player
}

/** Leave the lobby and the room. */
export function leave() {
  token++;
  phase = 'idle';
  started = false; forced = false;
  clearTimeout(retryTimer);
  retries = 0;
  lastFlow = null;
  everSeen = false; nobodyToasted = false; blockedToasted = false;
  if (state.online) session.leave();
  infos.clear();
  lastHostLobby = null;
  L.code = null; L.link = null; L.roomId = null; L.countdownEndsAt = null; L.bucket = 0; L.created = false; L.retryAt = null; L.seated = true;
  setRoomParam(null);
  setStatus('waiting', 'Not connected');
}

/** Host only: start now (empty slots filled with bots). Non-hosts (and a lone mid-match joiner of a private code): false. */
export function requestStart() {
  if (!state.online || !session.isHost() || phase !== 'settled' || started || !startAllowed()) return false;
  forced = true;
  L.countdownEndsAt = now();
  refresh(true);
  return true;
}

/**
 * START NOW for the lobby host, except for a player alone in a private room whose match is in progress: he joined
 * mid-match and waits for that round to end (a group back in the lobby may still start without the stragglers).
 */
function startAllowed() {
  return !(L.mode === 'private' && L.humans <= 1 && liveElsewhere());
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

function waitingText() {
  const blocked = blockedText();
  if (blocked) return blocked;
  if (L.matchInProgress && L.mode === 'private') {
    const lv = liveHere();
    return lv ? `${plural(lv.humans, 'player is', 'players are')} in a match (it ends within ${lv.minLeft} min). You deploy together in the next round.`
      : 'A match is in progress. You deploy in the next round.';
  }
  if (L.mode === 'quick' && L.matchInProgress && L.humans <= 1) {
    const lv = liveHere();
    if (lv) return `${plural(lv.humans, 'player is', 'players are')} in a match in this lobby (it ends within ${lv.minLeft} min). Wait here to deploy together in the next round, or play now with bots.`;
  }
  if (L.humans <= 1) {
    const mm = mismatchText();
    if (mm) return mm;
    if (L.mode !== 'private') return 'Waiting for players';
    if (L.created || everSeen) return 'Share the code to invite your squad';
    if (session.pendingAttempts() > 0) return `Connecting to the players in lobby ${L.code}`;
    return nobodyHere() ? `Nobody else is in lobby ${L.code} right now. Check the code with your squad, or wait here for them.`
      : `Looking for players in lobby ${L.code}`;
  }
  return 'Waiting for players';
}

/**
 * Players tried to connect to us (offer and answer exchanged) but no connection ever worked and nobody reaches us
 * through a relay: our network blocks direct connections (a strict firewall, some mobile or campus networks).
 */
function blockedText() {
  if (phase !== 'settled' || now() - settledAt < TUNE.blockedAfterMs || session.peers().length > 0) return null;
  if (!session.unreachable().length) return null;
  return 'Players are in this lobby, but your network blocks direct connections to them. Try another network, such as mobile data, or play practice.';
}

/** Players in this room we cannot reach (they tried, nothing connected, no relay either), while others are fine. */
function noteText() {
  if (phase !== 'settled' || session.peers().length === 0) return null;
  const n = session.unreachable().length;
  if (!n) return null;
  return n === 1 ? 'A player could not connect to you or anyone here: their network blocks direct connections.'
    : `${n} players could not connect to you or anyone here: their networks block direct connections.`;
}

/** Private join, not the creator: no player of this room seen for TUNE.nobodyAfterMs since we settled in it. */
function nobodyHere() {
  // a connection attempt under way means someone is here, even if it never connects (a blocked network)
  return L.mode === 'private' && !L.created && !everSeen && phase === 'settled' && now() - settledAt >= TUNE.nobodyAfterMs
    && session.pendingAttempts() === 0 && !session.unreachable().length;
}

/**
 * A player with another game version is in this room (net/session: his hello had another version): say who has to
 * reload, and who joined whom (`first`: he was in the room before us, so it is his lobby we tried to join).
 */
function mismatchText() {
  const m = session.versionMismatch();
  if (!m) return null;
  if (m.theirs > m.ours) {
    return m.first === true
      ? 'This lobby runs a newer version of ZONEFALL. Reload this page to update, then you can join.'
      : 'A player with a newer version of ZONEFALL tried to join. Reload this page to update, then you can play together.';
  }
  return m.first === true
    ? 'This lobby runs an older version of ZONEFALL. The players in it need to reload their page before you can join.'
    : 'A player with an older version of ZONEFALL tried to join. They need to reload their page before you can play together.';
}

/** Countdown, heartbeats, LOBBY_UPDATE emission. Called every frame while online (outside the lobby: heartbeat only). */
export function update(dt) {
  if (!state.online || phase === 'idle') { return; }
  const t = now();
  if (t >= nextHelloAt) { nextHelloAt = t + TUNE.helloEveryMs; sayHello(); }
  if (state.app !== APP.LOBBY) return;
  if (phase !== 'settled') { refresh(false); return; }
  if (!nobodyToasted && nobodyHere() && !session.versionMismatch() && !blockedText()) {
    nobodyToasted = true;
    emit(EV.TOAST, { text: `Nobody is in lobby ${L.code} right now. Check the code with your squad. You can wait here for them.`, kind: 'warn', ms: 7000 });
  }
  if (!blockedToasted && blockedText()) {
    blockedToasted = true;
    emit(EV.TOAST, { text: 'Your network blocks direct connections to the other players. Try another network, such as mobile data.', kind: 'danger', ms: 8000 });
  }

  const isHost = session.isHost();
  const humans = buildRoster();
  const live = liveElsewhere();
  if (started) { refresh(false); return; }

  // A full room that only showed it after we settled (the 11th player's connections form after the join probe):
  // never show him a countdown he will not deploy in. Quick play searches on; a private lobby waits for the next round.
  L.seated = isHost || humans.some((h) => h.self);
  if (!L.seated) {
    if (!unseatedSince) unseatedSince = t;
    L.countdownEndsAt = null;
    L.status = 'waiting';
    L.text = `This lobby is full (${TUNE.maxHumans} players). You deploy in the next round.`;
    refresh(false);
    if (L.mode === 'quick' && t - unseatedSince > TUNE.unseatedHopMs) quickPlay();
    return;
  }
  unseatedSince = 0;

  // Every relay lost while nobody else is here: hold the alone countdown (quick play would start a bot match that
  // nobody can join) and say so; Trystero's relay sockets reconnect by themselves (net/session relay keeper).
  if (humans.length <= 1 && !forced && session.linkHealth().relaysOpen === 0) {
    L.countdownEndsAt = null;
    aloneSince = t;
    L.status = 'connecting';
    L.text = 'Lost the matchmaking servers. Reconnecting';
    refresh(false);
    return;
  }

  if (isHost && t - settledAt >= TUNE.settleMs) {
    hostTick(t, humans, live);
    if (started) { refresh(false); return; }
  } else if (!isHost) {
    if (lastHostLobby && lastHostLobby.from === session.hostId()) {
      L.countdownEndsAt = lastHostLobby.cd == null ? null : lastHostLobby.at + lastHostLobby.cd - session.rtt(lastHostLobby.from) / 2;
    } else L.countdownEndsAt = null;
  }

  if (L.countdownEndsAt != null && !waitForLive(live, humans.length)) {
    const alone = humans.length <= 1;
    L.status = 'countdown';
    L.text = alone && !forced ? 'No other players yet. Deploying with bots' : 'Match starting';
  } else {
    L.status = blockedText() ? 'blocked' : 'waiting';
    L.text = waitingText();
  }
  refresh(false);
}

function hostTick(t, humans, live) {
  const n = humans.length;
  if (forced) {
    // START NOW: countdownEndsAt already set to now
  } else if (waitForLive(live, n)) {
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
