// ZONEFALL - lobby screen. OWNER: UI. Contract: ARCHITECTURE.md 9.
// Shows net/lobby.get(): mode, room code with copy-link button (location + '?room=CODE'), roster with host
// marker and the local player highlighted, "slots filled with bots at start", countdown, status text, connection
// diagnostics line (session.diagnostics(): relays open, per-peer RTT and channel). Buttons: START NOW (host only),
// RETRY (after a connection failure, with the automatic retry counting down), LEAVE. Re-renders on LOBBY_UPDATE; the
// countdown ticks every frame from update().
import { emit, on, EV } from '../core/bus.js';
import { MATCH, NET } from '../config.js';
import * as session from '../net/session.js';
import { h, sfx, GLYPH, setText, show as showEl, clock } from './dom.js';

let el = null, eyebrowEl, codeWrap, codeEl, copyBtn, countWrap, countEl, countLabel, statusEl, textEl;
let startBtn, leaveBtn, practiceBtn, retryBtn, rosterEl, rosterHead, diagEl, dotEl;
let last = null, lastSecond = -1, diagTimer = 0;

const REGION = { eu: 'Europe', na: 'North America', sa: 'South America', as: 'Asia', oc: 'Oceania', af: 'Africa' };
const STATUS_LABEL = { connecting: 'Connecting', waiting: 'Waiting for players', countdown: 'Countdown running', starting: 'Deploying', error: 'Connection problem' };

export function mount(root) {
  el = h('section', { class: 'zf-lobby', 'aria-label': 'Lobby', hidden: true });
  eyebrowEl = h('p', { class: 'zf-eyebrow' });
  codeEl = h('div', { class: 'zf-lobby__code', 'aria-label': 'Lobby code' });
  copyBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost zf-btn--sm', html: `${GLYPH.copy}<span>Copy invite link</span>` });
  copyBtn.addEventListener('click', copyLink);
  codeWrap = h('div', { class: 'zf-lobby__codewrap' }, h('span', { class: 'zf-label', text: 'Lobby code' }), codeEl, copyBtn);

  dotEl = h('span', { class: 'zf-lobby__dot' });
  statusEl = h('span', { class: 'zf-lobby__status' });
  countEl = h('div', { class: 'zf-lobby__count' });
  countLabel = h('span', { class: 'zf-label', text: 'Deploying in' });
  countWrap = h('div', { class: 'zf-lobby__countwrap' }, countLabel, countEl);
  textEl = h('p', { class: 'zf-lobby__text' });

  startBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--primary', html: `<span>Start now</span>${GLYPH.chevron}` });
  startBtn.addEventListener('click', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'start_now' }); });
  retryBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--primary', html: '<span>Retry</span>' });
  retryBtn.addEventListener('click', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'lobby_retry' }); });
  practiceBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--solid', html: '<span>Play practice instead</span>' });
  practiceBtn.addEventListener('click', () => { sfx('confirm'); emit(EV.UI_INTENT, { type: 'leave_lobby' }); emit(EV.UI_INTENT, { type: 'practice' }); });
  leaveBtn = h('button', { type: 'button', class: 'zf-btn zf-btn--ghost', html: `${GLYPH.back}<span>Leave lobby</span>` });
  leaveBtn.addEventListener('click', () => { sfx('back'); emit(EV.UI_INTENT, { type: 'leave_lobby' }); });

  const main = h('div', { class: 'zf-lobby__main' },
    eyebrowEl,
    h('h1', { class: 'zf-lobby__title', text: 'Lobby' }),
    codeWrap,
    h('div', { class: 'zf-lobby__state' }, dotEl, statusEl),
    countWrap, textEl,
    h('div', { class: 'zf-lobby__actions' }, startBtn, retryBtn, practiceBtn, leaveBtn),
    h('p', { class: 'zf-lobby__rules', text: `Countdown starts at ${MATCH.minHumansToCountdown} players (${MATCH.lobbyCountdown} s) and shortens to ${MATCH.lobbyCountdownFull} s at 6. Empty slots up to ${MATCH.maxPlayers} are filled with bots at start.` }));

  rosterHead = h('header', { class: 'zf-roster__head' });
  rosterEl = h('ol', { class: 'zf-roster__list' });
  const roster = h('section', { class: 'zf-roster', 'aria-label': 'Players' }, rosterHead, rosterEl);
  diagEl = h('footer', { class: 'zf-lobby__diag' });

  el.append(h('div', { class: 'zf-menu__scrim zf-menu__scrim--lobby' }), main, roster, diagEl);
  root.append(el);

  on(EV.NET_STATUS, () => { if (!el.hidden) renderDiag(); });
}

async function copyLink() {
  const code = last && last.code;
  if (!code) return;
  const link = (last && last.link) || `${location.origin}${location.pathname}?room=${code}`;
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = link;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  sfx(ok ? 'confirm' : 'error');
  copyBtn.querySelector('span').textContent = ok ? 'Link copied' : 'Copy failed';
  setTimeout(() => { copyBtn.querySelector('span').textContent = 'Copy invite link'; }, 1800);
  emit(EV.TOAST, { text: ok ? 'Invite link copied to the clipboard' : link, kind: ok ? 'info' : 'warn', ms: ok ? 2200 : 6000 });
}

export function show() {
  el.hidden = false;
  el.classList.remove('is-in');
  void el.offsetWidth;
  el.classList.add('is-in');
  lastSecond = -1;
}

export function hide() { el.hidden = true; }

function peerRtt() {
  const m = new Map();
  try { for (const p of session.diagnostics().peers || []) m.set(p.id, p); } catch (e) { /* offline */ }
  return m;
}

export function render(lobby) {
  if (!lobby) return;
  last = lobby;
  const mode = lobby.mode === 'private' ? 'Private lobby' : 'Quick play';
  const region = lobby.region ? (REGION[lobby.region] || lobby.region.toUpperCase()) : null;
  eyebrowEl.textContent = '';
  for (const t of [mode, region, lobby.mode !== 'private' && lobby.bucket ? `Lobby ${lobby.bucket}` : null].filter(Boolean)) eyebrowEl.append(h('span', { text: t }));

  showEl(codeWrap, !!lobby.code);
  if (lobby.code) setText(codeEl, lobby.code);

  setText(statusEl, STATUS_LABEL[lobby.status] || lobby.status || '');
  el.dataset.status = lobby.status || '';
  setText(textEl, lobby.text || '');
  showEl(startBtn, !!lobby.isHost && lobby.status !== 'starting' && lobby.status !== 'error' && lobby.status !== 'connecting');
  showEl(practiceBtn, lobby.status === 'error');
  showEl(retryBtn, lobby.status === 'error');

  // roster: humans first (host marked, self highlighted), then the bot-filled slots
  const rtt = peerRtt();
  rosterEl.textContent = '';
  const humans = lobby.roster || [];
  humans.forEach((p, i) => {
    const d = rtt.get(p.id);
    const ms = p.self ? null : d ? d.rtt : null;
    const bars = ms == null ? 0 : ms < 70 ? 3 : ms < 140 ? 2 : 1;
    const li = h('li', { class: 'zf-roster__row' + (p.self ? ' is-self' : '') + (p.host ? ' is-host' : '') },
      h('span', { class: 'zf-roster__idx', text: String(i + 1).padStart(2, '0') }),
      h('span', { class: 'zf-roster__name', text: p.name }),
      h('span', { class: 'zf-roster__tags' },
        p.host ? h('span', { class: 'zf-tag zf-tag--host', html: `${GLYPH.host}<span>Host</span>` }) : null,
        p.self ? h('span', { class: 'zf-tag zf-tag--self', text: 'You' }) : null),
      h('span', { class: 'zf-roster__ping', data: { bars: String(bars) } },
        p.self ? '' : ms ? `${ms} ms` : '...', h('i'), h('i'), h('i')));
    rosterEl.append(li);
  });
  const connected = humans.length > 0;
  const bots = connected ? Math.max(0, MATCH.maxPlayers - humans.length) : 0;
  if (!connected) {
    rosterEl.append(h('li', { class: 'zf-roster__empty', text: lobby.status === 'error' ? 'Not connected to a lobby.' : 'Looking for a lobby. Players appear here as they join.' }));
  }
  for (let i = 0; i < bots; i++) {
    rosterEl.append(h('li', { class: 'zf-roster__row is-bot' },
      h('span', { class: 'zf-roster__idx', text: String(humans.length + i + 1).padStart(2, '0') }),
      h('span', { class: 'zf-roster__name', html: `${GLYPH.bot}<span>Bot at start</span>` })));
  }
  rosterHead.innerHTML = '';
  rosterHead.append(
    h('span', { class: 'zf-label', text: 'Operators' }),
    h('span', { class: 'zf-roster__counts' }, h('b', { text: String(humans.length) }), ` / ${MATCH.maxHumans} players`, connected ? h('i', { text: `${bots} bots` }) : null));
  renderDiag();
  tick();
}

function renderDiag() {
  let d = null;
  try { d = session.diagnostics(); } catch (e) { d = null; }
  diagEl.textContent = '';
  if (!d) return;
  const parts = [
    ['Relays', `${d.relaysOpen ?? 0}/${NET.relays.length}`],
    ['Transport', d.transport || 'nostr'],
    ['Peers', String((d.peers || []).length)],
  ];
  if (d.hostId) parts.push(['Host', d.isHost ? 'you' : String(d.hostId).slice(0, 6)]);
  for (const p of (d.peers || []).slice(0, 6)) parts.push([String(p.id).slice(0, 6), `${p.rtt} ms ${p.channel === 'unreliable' ? 'udp' : 'reliable'} ${p.pair}${p.stale ? ' stale' : ''}`]);
  for (const [k, v] of parts) diagEl.append(h('span', null, h('b', { text: k }), ' ', v));
}

/** Per frame while the lobby is visible: countdown text and the last-10-seconds tick. */
export function tick() {
  if (!last || !el || el.hidden) return;
  if (last.status === 'error') {
    // the automatic retry counts down on the Retry button
    const left = last.retryAt != null ? Math.ceil((last.retryAt - performance.now()) / 1000) : 0;
    setText(retryBtn.querySelector('span'), left > 0 ? `Retry (auto in ${left} s)` : 'Retry');
  }
  const ends = last.countdownEndsAt;
  const counting = ends != null && (last.status === 'countdown' || last.status === 'waiting');
  showEl(countWrap, counting || last.status === 'starting');
  if (last.status === 'starting') { setText(countLabel, 'Deploying'); setText(countEl, '0:00'); return; }
  if (!counting) return;
  setText(countLabel, 'Deploying in');
  const s = Math.max(0, (ends - performance.now()) / 1000);
  setText(countEl, clock(s));
  const whole = Math.ceil(s);
  if (whole !== lastSecond) {
    if (lastSecond !== -1 && whole <= 10 && whole > 0) sfx('tick');
    lastSecond = whole;
    el.classList.toggle('is-final', whole <= 10);
  }
  diagTimer += 1;
  if (diagTimer % 60 === 0) renderDiag();
}
