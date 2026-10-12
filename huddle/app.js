(() => {
  'use strict';

  // ==========================================================================
  // Constants
  // ==========================================================================
  const STORE_KEY = 'huddle.v1';
  const REACTIONS = ['thumbs-up', 'heart', 'laugh', 'flame', 'check', 'eye'];
  const COLORS = ['#f2c14e', '#7fd1ae', '#8fb8ff', '#f28f6b', '#c6a4ff', '#e0e0e0', '#ff9fb2'];
  const STATUS_LABEL = { online: 'Available', busy: 'Busy', away: 'Away', offline: 'Offline' };
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // ==========================================================================
  // Helpers
  // ==========================================================================
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}"></i>`;
  const paintIcons = () => window.lucide && window.lucide.createIcons();

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }
  function colorFor(id) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  function avatar(user, size = '', withStatus = true) {
    if (!user) return '';
    const st = withStatus ? `<i class="st ${user.status || 'offline'}"></i>` : '';
    return `<span class="av ${size}" style="background:${colorFor(user.id)}" title="${esc(user.name)}">${esc(initials(user.name))}${st}</span>`;
  }
  function timeOf(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return 'Today';
    if (ts >= start - DAY) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function shortTime(ts) {
    const diff = Date.now() - ts;
    if (diff < MIN) return 'now';
    if (diff < HOUR) return Math.floor(diff / MIN) + 'm';
    if (diff < DAY) return timeOf(ts);
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** Minimal, safe formatting: code blocks, inline code, bold, links, mentions. */
  function format(text) {
    const blocks = [];
    let s = esc(text).replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre>${code.replace(/^\n/, '')}</pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)@([A-Za-z][\w-]*(?: [A-Z][\w-]*)?)/g, (m, pre, name) => {
        const u = findUserByMention(name);
        return u ? `${pre}<span class="at">@${esc(u.name)}</span>` : m;
      });
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  function findUserByMention(name) {
    const n = name.toLowerCase();
    return state.users.find(u => u.name.toLowerCase() === n) ||
      state.users.find(u => u.name.split(' ')[0].toLowerCase() === n.split(' ')[0]);
  }

  // ==========================================================================
  // Seed data
  // ==========================================================================
  function seed(myName) {
    const now = Date.now();
    const me = { id: 'me', name: myName, status: 'online', title: 'Founder' };
    const users = [
      me,
      { id: 'noor', name: 'Noor Bakker', status: 'online', title: 'Product designer' },
      { id: 'daan', name: 'Daan Visser', status: 'busy', title: 'Frontend developer' },
      { id: 'sem', name: 'Sem de Jong', status: 'away', title: 'Backend developer' },
      { id: 'lotte', name: 'Lotte Mulder', status: 'online', title: 'QA and community' },
      { id: 'milan', name: 'Milan Smit', status: 'offline', title: 'Sound design' },
    ];
    const teams = [
      { id: 'studio', name: 'Studio', channels: [
        { id: 'general', name: 'general', topic: 'Everything that does not fit anywhere else' },
        { id: 'design', name: 'design', topic: 'Figma links, critiques and type nerdery' },
        { id: 'dev', name: 'dev', topic: 'Code, reviews and deploys' },
        { id: 'releases', name: 'releases', topic: 'What shipped and when' },
      ] },
      { id: 'brawl', name: 'Blokbrawl', channels: [
        { id: 'playtest', name: 'playtest', topic: 'Feedback from test sessions' },
        { id: 'bugs', name: 'bugs', topic: 'Repro steps or it did not happen' },
      ] },
    ];
    const dms = [
      { id: 'dm-noor', members: ['me', 'noor'] },
      { id: 'dm-daan', members: ['me', 'daan'] },
      { id: 'dm-lotte', members: ['me', 'lotte'] },
      { id: 'dm-sem', members: ['me', 'sem'] },
    ];
    const m = (conv, author, text, ago, extra = {}) => ({ id: uid(), conv, author, text, ts: now - ago, reactions: {}, replies: [], files: [], ...extra });
    const messages = {
      general: [
        m('general', 'noor', 'Morning all. New coffee machine on the second floor finally works.', 26 * HOUR),
        m('general', 'sem', 'Confirmed. It makes one size and that size is large.', 25.8 * HOUR, { reactions: { laugh: ['noor', 'lotte'] } }),
        m('general', 'lotte', 'Reminder: playtest friday at 15:00. Bring a mouse, trackpads are banned.', 3 * HOUR, { reactions: { check: ['daan', 'sem'] } }),
        m('general', 'daan', '@' + myName.split(' ')[0] + ' can you share the build link before friday?', 40 * MIN),
      ],
      design: [
        m('design', 'noor', 'Pushed the new type scale. Anton for display, DM Mono for labels, Geist for body.', 5 * HOUR),
        m('design', 'noor', 'Rule of thumb: if a label explains state, it goes mono and uppercase.', 4.9 * HOUR),
        m('design', 'me', 'Love it. No rounded corners anywhere, right?', 4.6 * HOUR, { reactions: { 'thumbs-up': ['noor'] } }),
        m('design', 'noor', 'Zero. Sharp edges, 1px lines, one red.', 4.5 * HOUR, {
          replies: [
            { id: uid(), author: 'daan', text: 'Does that include the focus ring?', ts: now - 4.4 * HOUR, reactions: {} },
            { id: uid(), author: 'noor', text: 'Focus ring stays 1px, text colour. Accessible and on brand.', ts: now - 4.3 * HOUR, reactions: {} },
          ],
        }),
      ],
      dev: [
        m('dev', 'daan', 'Ramp collision is fixed. You can now run up a ramp chain without snapping through.', 7 * HOUR),
        m('dev', 'sem', 'Nice. What was it?', 6.9 * HOUR),
        m('dev', 'daan', 'Ground check used a fixed step height. Ramps now report their own height per position:\n```\ntop = rampHeight(piece, x, z) + 0.12\nif (top > y + 1.1) continue\n```', 6.8 * HOUR, { reactions: { flame: ['sem', 'me'] } }),
        m('dev', 'sem', 'Deploying to pages now. `main` is green.', 2 * HOUR),
      ],
      releases: [
        m('releases', 'me', '**Blokbrawl** is live on GitHub Pages. Walls, ramps, floors, two weapons and a bot that builds back.', 30 * HOUR, { reactions: { flame: ['noor', 'daan', 'sem', 'lotte'] } }),
        m('releases', 'me', '**Huddle** is live. Channels, DMs, threads, reactions, search and calls.', 20 * MIN),
      ],
      playtest: [
        m('playtest', 'lotte', 'Session 3 notes: bot on hard boxes up too fast, everyone loved it.', 22 * HOUR),
        m('playtest', 'milan', 'Shotgun needs more punch in the sound. On my list.', 21 * HOUR),
      ],
      bugs: [
        m('bugs', 'lotte', 'Camera clips into your own wall when you box up. Repro: Q four times, look behind you.', 9 * HOUR),
        m('bugs', 'daan', 'Fixed, own builds fade out when they block the camera now.', 8 * HOUR, { reactions: { check: ['lotte'] } }),
      ],
      'dm-noor': [
        m('dm-noor', 'noor', 'Got 10 minutes later for the marketplace layout?', 2.5 * HOUR),
        m('dm-noor', 'me', 'Yes, after lunch.', 2.4 * HOUR),
      ],
      'dm-daan': [
        m('dm-daan', 'daan', 'Build link for friday?', 45 * MIN),
      ],
      'dm-lotte': [
        m('dm-lotte', 'lotte', 'I set up the playtest room. 6 seats.', 3.5 * HOUR),
      ],
      'dm-sem': [],
    };
    const reads = {};
    for (const k of Object.keys(messages)) reads[k] = now;
    reads['general'] = now - HOUR;
    reads['dm-daan'] = now - HOUR;
    reads['releases'] = now - HOUR;
    return {
      version: 1, me: 'me', users, teams, dms, messages, reads,
      calls: [
        { id: uid(), with: 'noor', dir: 'in', ts: now - 27 * HOUR, dur: 14 * 60 },
        { id: uid(), with: 'daan', dir: 'out', ts: now - 50 * HOUR, dur: 6 * 60 },
        { id: uid(), with: 'lotte', dir: 'missed', ts: now - 3 * DAY, dur: 0 },
      ],
      activitySeen: now - HOUR,
      collapsed: {},
    };
  }

  // ==========================================================================
  // State + persistence (localStorage, synced across tabs)
  // ==========================================================================
  let state = null;
  const ui = {
    section: 'teams', conv: 'general', tab: 'posts', thread: null,
    typing: {}, pendingFiles: [], editing: null, pickFor: null,
  };
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('huddle') : null;
  const tabId = uid();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) state = JSON.parse(raw);
    } catch { state = null; }
  }
  function save(broadcast = true) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch { toast(null, 'Storage full', 'Older attachments could not be saved.'); }
    if (broadcast && channel) channel.postMessage({ type: 'sync', from: tabId });
  }
  if (channel) {
    channel.onmessage = e => {
      if (e.data?.from === tabId) return;
      if (e.data.type === 'sync') { load(); render(); }
      if (e.data.type === 'typing') { setTyping(e.data.conv, 'me-other', true); }
    };
  }

  const me = () => state.users.find(u => u.id === state.me);
  const user = id => state.users.find(u => u.id === id);
  const allChannels = () => state.teams.flatMap(t => t.channels.map(c => ({ ...c, team: t })));

  function convInfo(id) {
    const ch = allChannels().find(c => c.id === id);
    if (ch) return { kind: 'channel', id, name: ch.name, title: `${ch.team.name} / ${ch.name}`, topic: ch.topic, team: ch.team };
    const dm = state.dms.find(d => d.id === id);
    if (dm) {
      const other = user(dm.members.find(x => x !== state.me));
      return { kind: 'dm', id, name: other.name, title: other.name, topic: `${STATUS_LABEL[other.status]} / ${other.title}`, other };
    }
    return null;
  }

  function unreadCount(conv) {
    const last = state.reads[conv] || 0;
    return (state.messages[conv] || []).filter(m => m.ts > last && m.author !== state.me).length;
  }
  function lastMessage(conv) {
    const list = state.messages[conv] || [];
    return list[list.length - 1];
  }
  function markRead(conv) {
    const last = lastMessage(conv);
    if (!last) return;
    if ((state.reads[conv] || 0) < last.ts) { state.reads[conv] = last.ts; save(); }
  }

  function activityItems() {
    const first = me().name.split(' ')[0].toLowerCase();
    const items = [];
    for (const [conv, list] of Object.entries(state.messages)) {
      for (const msg of list) {
        if (msg.author !== state.me && new RegExp(`@${first}\\b`, 'i').test(msg.text)) {
          items.push({ kind: 'mention', conv, msg, ts: msg.ts });
        }
        if (msg.author === state.me) {
          for (const r of msg.replies || []) if (r.author !== state.me) items.push({ kind: 'reply', conv, msg, reply: r, ts: r.ts });
          for (const [rx, who] of Object.entries(msg.reactions || {})) {
            for (const w of who) if (w !== state.me) items.push({ kind: 'react', conv, msg, rx, who: w, ts: msg.ts + 1 });
          }
        }
      }
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 60);
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================
  const els = {
    app: $('#app'), side: $('#side'), main: $('#main'), thread: $('#thread'), call: $('#call'),
    palette: $('#palette'), paletteInput: $('#paletteInput'), paletteResults: $('#paletteResults'),
    modal: $('#modal'), toasts: $('#toasts'), meBtn: $('#meBtn'),
  };

  function render() {
    if ((ui.section === 'chat' || ui.section === 'teams') && ui.tab === 'posts' && convInfo(ui.conv)) markRead(ui.conv);
    renderRail();
    renderSide();
    renderMain();
    renderThread();
    paintIcons();
  }

  function renderRail() {
    $$('.rail-btn[data-section]').forEach(b => b.classList.toggle('on', b.dataset.section === ui.section));
    const chatUnread = state.dms.reduce((n, d) => n + unreadCount(d.id), 0);
    const teamUnread = allChannels().reduce((n, c) => n + unreadCount(c.id), 0);
    const act = activityItems().filter(a => a.ts > state.activitySeen).length;
    $('#badgeChat').textContent = chatUnread || '';
    $('#badgeTeams').textContent = teamUnread || '';
    $('#badgeActivity').textContent = act || '';
    els.meBtn.innerHTML = avatar(me());
    els.app.classList.toggle('in-conv', ui.mobileConv === true);
    document.title = (chatUnread + teamUnread ? `(${chatUnread + teamUnread}) ` : '') + 'Huddle';
  }

  function sideHead(title, tools = '') {
    return `<div class="side-head"><h2>${title}</h2><div class="side-tools">${tools}</div></div>
      <button class="side-search" data-action="palette">${icon('search')}Search<kbd>CTRL K</kbd></button>`;
  }

  function renderSide() {
    let html = '';
    if (ui.section === 'teams') {
      html += sideHead('Teams', `<button class="icon-btn" data-action="new-channel" title="New channel">${icon('plus')}</button>`);
      html += '<div class="side-scroll">';
      for (const t of state.teams) {
        const closed = state.collapsed[t.id];
        html += `<div class="group ${closed ? 'closed' : ''}">
          <button class="group-head" data-action="toggle-group" data-id="${t.id}">${icon('chevron-down')}<span class="label">${esc(t.name)}</span></button>
          <div class="items">`;
        for (const c of t.channels) {
          const n = unreadCount(c.id);
          html += `<button class="item ${ui.conv === c.id ? 'on' : ''} ${n ? 'unread' : ''}" data-action="open" data-id="${c.id}">
            <span class="hash">#</span><span class="name">${esc(c.name)}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`;
        }
        html += '</div></div>';
      }
      html += '</div>';
    } else if (ui.section === 'chat') {
      html += sideHead('Chat', `<button class="icon-btn" data-action="new-dm" title="New chat">${icon('square-pen')}</button>`);
      html += '<div class="side-scroll"><div class="group"><div class="items">';
      const dms = [...state.dms].sort((a, b) => (lastMessage(b.id)?.ts || 0) - (lastMessage(a.id)?.ts || 0));
      for (const d of dms) {
        const other = user(d.members.find(x => x !== state.me));
        const last = lastMessage(d.id);
        const n = unreadCount(d.id);
        const preview = last ? (last.author === state.me ? 'You: ' : '') + last.text.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ') : 'No messages yet';
        html += `<button class="item dm ${ui.conv === d.id ? 'on' : ''} ${n ? 'unread' : ''}" data-action="open" data-id="${d.id}">
          ${avatar(other)}<span class="name">${esc(other.name)}<span class="sub">${esc(preview)}</span></span>
          ${n ? `<span class="count">${n}</span>` : last ? `<span class="time">${shortTime(last.ts)}</span>` : ''}</button>`;
      }
      html += '</div></div></div>';
    } else if (ui.section === 'activity') {
      html += sideHead('Activity');
      html += `<div class="side-scroll"><div class="group"><div class="items">
        <button class="item on"><span class="hash">${icon('at-sign')}</span><span class="name">Mentions, replies and reactions</span></button>
      </div></div></div>`;
    } else if (ui.section === 'calls') {
      html += sideHead('Calls');
      html += '<div class="side-scroll"><div class="group"><span class="group-head"><span class="label">Contacts</span></span><div class="items">';
      for (const u of state.users.filter(u => u.id !== state.me)) {
        html += `<div class="item dm">${avatar(u)}<span class="name">${esc(u.name)}<span class="sub">${STATUS_LABEL[u.status]}</span></span>
          <button class="icon-btn" data-action="call" data-id="${u.id}" title="Call ${esc(u.name)}">${icon('phone')}</button></div>`;
      }
      html += '</div></div></div>';
    }
    els.side.innerHTML = html;
  }

  function renderMain() {
    if (ui.section === 'activity') return renderActivity();
    if (ui.section === 'calls') return renderCalls();
    const info = convInfo(ui.conv);
    if (!info) {
      els.main.innerHTML = `<div class="empty"><div><h3>PICK A CONVERSATION</h3><p>Choose a channel or chat on the left.</p></div></div>`;
      return;
    }
    const list = state.messages[ui.conv] || [];
    const prevScroll = $('.messages', els.main);
    const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 80;
    const keepTop = prevScroll && els.main.dataset.conv === ui.conv ? prevScroll.scrollTop : null;

    const head = `<header class="conv-head">
      <button class="icon-btn back" data-action="back">${icon('arrow-left')}</button>
      ${info.kind === 'dm' ? avatar(info.other) : ''}
      <div class="conv-title"><strong>${info.kind === 'channel' ? '# ' : ''}${esc(info.name)}</strong><span>${esc(info.kind === 'channel' ? info.team.name + ' / ' + info.topic : info.topic)}</span></div>
      <div class="tabs">
        <button class="tab ${ui.tab === 'posts' ? 'on' : ''}" data-action="tab" data-id="posts">${info.kind === 'dm' ? 'Chat' : 'Posts'}</button>
        <button class="tab ${ui.tab === 'files' ? 'on' : ''}" data-action="tab" data-id="files">Files</button>
      </div>
      <div class="conv-tools">
        ${info.kind === 'dm'
          ? `<button class="btn ghost" data-action="call" data-id="${info.other.id}">${icon('video')}<span>Call</span></button>`
          : `<button class="btn ghost" data-action="meet">${icon('video')}<span>Meet</span></button>`}
      </div>
    </header>`;

    if (ui.tab === 'files') {
      const files = list.flatMap(m => (m.files || []).map(f => ({ ...f, by: user(m.author), ts: m.ts })));
      els.main.innerHTML = head + `<div class="files-view">${files.length ? `<table class="table">
        <thead><tr><th class="label">Name</th><th class="label">Shared by</th><th class="label">Size</th><th class="label">When</th></tr></thead>
        <tbody>${files.map(f => `<tr><td><a href="${f.data}" download="${esc(f.name)}">${esc(f.name)}</a></td><td>${esc(f.by?.name || '')}</td><td>${fmtSize(f.size)}</td><td>${dayLabel(f.ts)}</td></tr>`).join('')}</tbody>
      </table>` : `<div class="empty"><div><h3>NO FILES YET</h3><p>Drop a file in the composer to share it here.</p></div></div>`}</div>`;
      els.main.dataset.conv = ui.conv;
      return;
    }

    const body = list.length ? renderMessages(list, ui.conv) : `<div class="empty"><div><h3>SAY HI</h3><p>This is the start of ${info.kind === 'dm' ? 'your chat with ' + esc(info.name) : '#' + esc(info.name)}.</p></div></div>`;
    els.main.innerHTML = head + `<div class="messages" id="msgs">${body}</div>
      <div class="typing" id="typing">${typingLine(ui.conv)}</div>
      ${composer('main', info.kind === 'dm' ? 'Message ' + info.name : 'Post in #' + info.name)}`;
    els.main.dataset.conv = ui.conv;

    const sc = $('#msgs');
    if (keepTop !== null && !atBottom) sc.scrollTop = keepTop;
    else sc.scrollTop = sc.scrollHeight;
    markRead(ui.conv);
    if (ui.restoreDraft) { const ta = $('textarea', els.main); ta.value = ui.restoreDraft; ui.restoreDraft = null; autosize(ta); }
  }

  function renderMessages(list, conv, inThread = false) {
    let html = '';
    let lastDay = '', lastAuthor = '', lastTs = 0;
    const first = me().name.split(' ')[0].toLowerCase();
    for (const msg of list) {
      const d = dayLabel(msg.ts);
      if (d !== lastDay && !inThread) { html += `<div class="day label">${d}</div>`; lastAuthor = ''; lastDay = d; }
      const cont = msg.author === lastAuthor && msg.ts - lastTs < 5 * MIN;
      lastAuthor = msg.author; lastTs = msg.ts;
      html += renderMessage(msg, conv, cont, inThread, first);
    }
    return html;
  }

  function renderMessage(msg, conv, cont, inThread, first) {
    const u = user(msg.author) || { id: 'x', name: 'Unknown' };
    const mention = msg.author !== state.me && new RegExp(`@${first}\\b`, 'i').test(msg.text);
    const reacts = Object.entries(msg.reactions || {}).filter(([, w]) => w.length);
    const editing = ui.editing === msg.id;
    const replies = msg.replies || [];
    const repliers = [...new Set(replies.map(r => r.author))].slice(0, 3).map(id => avatar(user(id), '', false)).join('');
    return `<div class="msg ${cont ? 'cont' : ''} ${mention ? 'mention' : ''}" data-id="${msg.id}" data-conv="${conv}" ${inThread ? 'data-thread="1"' : ''}>
      ${avatar(u)}
      <div>
        <div class="meta"><b>${esc(u.name)}</b><time title="${new Date(msg.ts).toLocaleString()}">${timeOf(msg.ts)}</time>${msg.edited ? '<span class="edited">(edited)</span>' : ''}</div>
        ${editing
          ? `<div class="composer" data-edit="${msg.id}"><textarea rows="1">${esc(msg.text)}</textarea><div class="composer-bar"><span class="hint">ENTER TO SAVE / ESC TO CANCEL</span></div></div>`
          : `<div class="body">${format(msg.text)}</div>`}
        ${(msg.files || []).length ? `<div class="files">${msg.files.map(fileChip).join('')}</div>` : ''}
        ${reacts.length ? `<div class="reacts">${reacts.map(([rx, who]) => `<button class="react ${who.includes(state.me) ? 'mine' : ''}" data-action="react" data-rx="${rx}" title="${esc(who.map(w => user(w)?.name || w).join(', '))}">${icon(rx)}${who.length}</button>`).join('')}</div>` : ''}
        ${!inThread && replies.length ? `<button class="replies-link" data-action="thread">${repliers}${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}<span class="label">${shortTime(replies[replies.length - 1].ts)}</span></button>` : ''}
      </div>
      <div class="tools">
        <button data-action="pick" title="React">${icon('smile-plus')}</button>
        ${!inThread ? `<button data-action="thread" title="Reply in thread">${icon('message-square-reply')}</button>` : ''}
        ${msg.author === state.me ? `<button data-action="edit" title="Edit">${icon('pencil')}</button><button data-action="delete" title="Delete">${icon('trash-2')}</button>` : ''}
        <button data-action="copy" title="Copy text">${icon('copy')}</button>
      </div>
      ${ui.pickFor === msg.id ? `<div class="react-pick">${REACTIONS.map(r => `<button data-action="react" data-rx="${r}" title="${r}">${icon(r)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function fileChip(f) {
    if (f.type?.startsWith('image/')) return `<a class="file img" href="${f.data}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${f.data}" alt="${esc(f.name)}"></a>`;
    return `<a class="file" href="${f.data}" download="${esc(f.name)}">${icon('file')}<span>${esc(f.name)}<small>${fmtSize(f.size)}</small></span></a>`;
  }

  function composer(where, placeholder) {
    const pend = where === 'main' && ui.pendingFiles.length
      ? `<div class="pending-files">${ui.pendingFiles.map((f, i) => `<span>${esc(f.name)}<button data-action="unpend" data-i="${i}">${icon('x')}</button></span>`).join('')}</div>` : '';
    return `<div class="composer" data-where="${where}">${pend}
      <textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
      <div class="composer-bar">
        <button class="icon-btn" data-action="fmt" data-wrap="**" title="Bold">${icon('bold')}</button>
        <button class="icon-btn" data-action="fmt" data-wrap="\`" title="Code">${icon('code')}</button>
        <button class="icon-btn" data-action="mention" title="Mention someone">${icon('at-sign')}</button>
        ${where === 'main' ? `<label class="icon-btn" title="Attach file">${icon('paperclip')}<input type="file" multiple hidden data-action="attach"></label>` : ''}
        <span class="hint">SHIFT + ENTER FOR NEW LINE</span>
        <button class="send" data-action="send" title="Send" disabled>${icon('send-horizontal')}</button>
      </div></div>`;
  }

  function typingLine(conv) {
    const who = Object.keys(ui.typing[conv] || {});
    if (!who.length) return '';
    const names = who.map(id => id === 'me-other' ? 'You (other tab)' : user(id)?.name.split(' ')[0]).filter(Boolean);
    return `<i><b></b><b></b><b></b></i>${esc(names.join(', '))} ${names.length > 1 ? 'are' : 'is'} typing`;
  }

  function renderThread() {
    if (!ui.thread || ui.section === 'activity' || ui.section === 'calls') { els.thread.hidden = true; return; }
    const msg = (state.messages[ui.thread.conv] || []).find(m => m.id === ui.thread.id);
    if (!msg) { ui.thread = null; els.thread.hidden = true; return; }
    const info = convInfo(ui.thread.conv);
    const first = me().name.split(' ')[0].toLowerCase();
    const sc = $('.messages', els.thread);
    const atBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
    els.thread.hidden = false;
    els.thread.innerHTML = `<header class="conv-head">
        <div class="conv-title"><strong>Thread</strong><span>${info.kind === 'channel' ? '# ' : ''}${esc(info.name)}</span></div>
        <div class="conv-tools"><button class="icon-btn" data-action="close-thread" title="Close">${icon('x')}</button></div>
      </header>
      <div class="messages">
        <div class="root">${renderMessage(msg, ui.thread.conv, false, true, first)}</div>
        <div class="label" style="padding:4px 20px 8px">${msg.replies.length} ${msg.replies.length === 1 ? 'REPLY' : 'REPLIES'}</div>
        ${msg.replies.map(r => renderMessage(r, ui.thread.conv, false, true, first)).join('')}
      </div>
      ${composer('thread', 'Reply')}`;
    const s = $('.messages', els.thread);
    if (atBottom) s.scrollTop = s.scrollHeight;
  }

  function renderActivity() {
    const items = activityItems();
    const seen = state.activitySeen;
    els.main.innerHTML = `<header class="conv-head"><div class="conv-title"><strong>Activity</strong><span>Mentions, replies to your posts and reactions</span></div></header>
      <div class="activity-view">${items.length ? items.map(a => {
        const info = convInfo(a.conv);
        const actor = user(a.kind === 'reply' ? a.reply.author : a.kind === 'react' ? a.who : a.msg.author);
        const what = a.kind === 'mention' ? 'Mentioned you' : a.kind === 'reply' ? 'Replied to your post' : 'Reacted to your post';
        const snip = a.kind === 'reply' ? a.reply.text : a.msg.text;
        return `<button class="act ${a.ts > seen ? 'new' : ''}" data-action="goto" data-conv="${a.conv}" data-id="${a.msg.id}" data-thread="${a.kind === 'reply' ? 1 : ''}">
          ${avatar(actor)}<span><span class="what">${esc(actor?.name || '')} / ${what} / ${info.kind === 'channel' ? '#' : ''}${esc(info.name)}</span><span class="snip">${esc(snip)}</span></span>
          <span class="label">${shortTime(a.ts)}</span></button>`;
      }).join('') : `<div class="empty"><div><h3>ALL QUIET</h3><p>Nothing new for you.</p></div></div>`}</div>`;
    state.activitySeen = Date.now();
    save();
  }

  function renderCalls() {
    const rows = [...state.calls].sort((a, b) => b.ts - a.ts);
    els.main.innerHTML = `<header class="conv-head"><div class="conv-title"><strong>Call history</strong><span>Recent calls</span></div></header>
      <div class="calls-view"><table class="table">
        <thead><tr><th class="label">Contact</th><th class="label">Type</th><th class="label">Duration</th><th class="label">When</th><th></th></tr></thead>
        <tbody>${rows.map(c => {
          const u = user(c.with);
          return `<tr><td>${esc(u?.name || '')}</td><td>${c.dir === 'missed' ? '<span style="color:var(--accent)">Missed</span>' : c.dir === 'in' ? 'Incoming' : 'Outgoing'}</td>
            <td>${c.dur ? `${Math.floor(c.dur / 60)}m ${String(c.dur % 60).padStart(2, '0')}s` : '-'}</td><td>${dayLabel(c.ts)} ${timeOf(c.ts)}</td>
            <td style="text-align:right"><button class="btn ghost" data-action="call" data-id="${c.with}">${icon('phone')}Call back</button></td></tr>`;
        }).join('')}</tbody></table></div>`;
  }

  // ==========================================================================
  // Actions
  // ==========================================================================
  function openConv(id, { scrollTo } = {}) {
    const info = convInfo(id);
    if (!info) return;
    ui.section = info.kind === 'dm' ? 'chat' : 'teams';
    ui.conv = id;
    ui.tab = 'posts';
    ui.editing = null; ui.pickFor = null; ui.pendingFiles = [];
    ui.mobileConv = true;
    if (ui.thread && ui.thread.conv !== id) ui.thread = null;
    render();
    if (scrollTo) {
      const el = $(`.msg[data-id="${scrollTo}"]`, els.main);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
    }
    const ta = $('textarea', els.main);
    if (ta && !matchMedia('(pointer: coarse)').matches) ta.focus();
  }

  function findMsg(conv, id) {
    const list = state.messages[conv] || [];
    for (const m of list) {
      if (m.id === id) return { msg: m, parent: null, list };
      const r = (m.replies || []).find(x => x.id === id);
      if (r) return { msg: r, parent: m, list: m.replies };
    }
    return null;
  }

  function send(where, text) {
    text = text.trim();
    if (!text && !(where === 'main' && ui.pendingFiles.length)) return;
    const now = Date.now();
    if (where === 'thread') {
      const root = findMsg(ui.thread.conv, ui.thread.id)?.msg;
      if (!root) return;
      root.replies.push({ id: uid(), author: state.me, text, ts: now, reactions: {} });
      save();
      render();
      scheduleReply(ui.thread.conv, text, root);
      return;
    }
    const msg = { id: uid(), conv: ui.conv, author: state.me, text, ts: now, reactions: {}, replies: [], files: ui.pendingFiles };
    ui.pendingFiles = [];
    (state.messages[ui.conv] ||= []).push(msg);
    state.reads[ui.conv] = now;
    save();
    render();
    scheduleReply(ui.conv, text, null);
  }

  // Teammates answer DMs and mentions so the workspace feels alive.
  const REPLIES = {
    greet: ['Hey! What is up?', 'Hi. Here.', 'Yo. Go ahead.'],
    question: ['Good question. Let me check and get back to you.', 'I think so, but double check with Sem.', 'Not sure yet. Can we look at it together after lunch?', 'Yes. Already on it.'],
    thanks: ['Anytime.', 'No problem.', 'Glad it helped.'],
    link: ['Opening it now.', 'Looks good from here.', 'Nice, saved it.'],
    general: ['Makes sense.', 'Agreed.', 'On it.', 'Noted, I will pick that up today.', 'Ha, fair.', 'Sounds good. Ship it.', 'Let me think about that one.'],
  };
  function pickReply(text) {
    const t = text.toLowerCase();
    const pool = /^(hi|hey|hoi|hallo|yo|hello)\b/.test(t) ? REPLIES.greet
      : /thank|thx|bedankt|dank/.test(t) ? REPLIES.thanks
      : /https?:\/\//.test(t) ? REPLIES.link
      : /\?\s*$/.test(t) ? REPLIES.question : REPLIES.general;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function scheduleReply(conv, text, threadRoot) {
    const info = convInfo(conv);
    let responder = null;
    if (info.kind === 'dm') responder = info.other;
    else {
      const m = text.match(/@([A-Za-z][\w-]*)/);
      if (m) responder = findUserByMention(m[1]);
      if (!responder && threadRoot && threadRoot.author !== state.me) responder = user(threadRoot.author);
    }
    if (!responder || responder.id === state.me || responder.status === 'offline') return;
    const delay = responder.status === 'away' ? 6000 : 1200 + Math.random() * 1800;
    setTimeout(() => {
      setTyping(conv, responder.id, true);
      setTimeout(() => {
        setTyping(conv, responder.id, false);
        const reply = { id: uid(), author: responder.id, text: pickReply(text), ts: Date.now(), reactions: {} };
        if (threadRoot) {
          const root = findMsg(conv, threadRoot.id)?.msg;
          if (!root) return;
          root.replies.push(reply);
        } else {
          (state.messages[conv] ||= []).push({ ...reply, conv, replies: [], files: [] });
        }
        save();
        const visible = ui.conv === conv && document.hasFocus() && (ui.section === 'chat' || ui.section === 'teams');
        render();
        if (!visible) toast(responder, responder.name, reply.text, () => openConv(conv));
      }, 900 + Math.min(2500, reply_len(text) * 20));
    }, delay);
  }
  const reply_len = t => Math.max(20, Math.min(120, t.length));

  function setTyping(conv, who, on) {
    ui.typing[conv] ||= {};
    if (on) {
      ui.typing[conv][who] = true;
      clearTimeout(ui.typing[conv]['_t' + who]);
      if (who === 'me-other') ui.typing[conv]['_t' + who] = setTimeout(() => setTyping(conv, who, false), 2500);
    } else delete ui.typing[conv][who];
    const visible = Object.keys(ui.typing[conv]).filter(k => !k.startsWith('_t'));
    if (!visible.length) ui.typing[conv] = {};
    const el = $('#typing');
    if (el && ui.conv === conv) { el.innerHTML = typingLine(conv); }
  }

  function toggleReaction(conv, id, rx) {
    const found = findMsg(conv, id);
    if (!found) return;
    const r = found.msg.reactions ||= {};
    const list = r[rx] ||= [];
    const i = list.indexOf(state.me);
    if (i >= 0) list.splice(i, 1); else list.push(state.me);
    if (!list.length) delete r[rx];
    ui.pickFor = null;
    save();
    render();
  }

  function deleteMsg(conv, id) {
    const found = findMsg(conv, id);
    if (!found) return;
    modal(`<h3>DELETE MESSAGE</h3><p>This removes it for everyone. It cannot be undone.</p>
      <div class="modal-actions"><button class="btn" data-modal="close">Cancel</button><button class="btn primary" data-modal="ok">Delete</button></div>`, () => {
      const i = found.list.indexOf(found.msg);
      if (i >= 0) found.list.splice(i, 1);
      if (!found.parent && ui.thread?.id === id) ui.thread = null;
      save();
      render();
    });
  }

  function saveEdit(conv, id, text) {
    const found = findMsg(conv, id);
    ui.editing = null;
    if (found && text.trim() && text.trim() !== found.msg.text) {
      found.msg.text = text.trim();
      found.msg.edited = true;
      save();
    }
    render();
  }

  function newChannel() {
    modal(`<h3>NEW CHANNEL</h3><p>Channels are where your team talks about one topic.</p>
      <label class="field"><span class="label">Team</span><select name="team">${state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span class="label">Name</span><input name="name" placeholder="e.g. marketing" maxlength="40" required></label>
      <label class="field"><span class="label">Topic</span><input name="topic" placeholder="What is it about?" maxlength="80"></label>
      <div class="modal-actions"><button class="btn" data-modal="close">Cancel</button><button class="btn primary" data-modal="ok">Create</button></div>`, form => {
      const name = form.name.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!name) return false;
      const id = name + '-' + uid().slice(0, 4);
      state.teams.find(t => t.id === form.team.value).channels.push({ id, name, topic: form.topic.value.trim() || 'No topic yet' });
      state.messages[id] = [];
      save();
      openConv(id);
    });
  }

  function newDm() {
    const others = state.users.filter(u => u.id !== state.me);
    modal(`<h3>NEW CHAT</h3><p>Start a conversation with someone on your team.</p>
      <label class="field"><span class="label">Person</span><select name="who">${others.map(u => `<option value="${u.id}">${esc(u.name)} - ${esc(u.title)}</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn" data-modal="close">Cancel</button><button class="btn primary" data-modal="ok">Open chat</button></div>`, form => {
      const who = form.who.value;
      let dm = state.dms.find(d => d.members.includes(who) && d.members.includes(state.me));
      if (!dm) {
        dm = { id: 'dm-' + who, members: [state.me, who] };
        state.dms.push(dm);
        state.messages[dm.id] = [];
        save();
      }
      openConv(dm.id);
    });
  }

  function statusModal() {
    const u = me();
    modal(`<h3>${esc(u.name.toUpperCase())}</h3><p>${esc(u.title)}</p>
      <div class="status-list">${['online', 'busy', 'away', 'offline'].map(s => `<button type="button" data-status="${s}" class="${u.status === s ? 'on' : ''}"><i class="sw" style="background:var(--${s === 'online' ? 'ok' : s === 'offline' ? 'muted' : s})"></i>${STATUS_LABEL[s]}</button>`).join('')}</div>
      <label class="field"><span class="label">Display name</span><input name="name" value="${esc(u.name)}" maxlength="40"></label>
      <div class="modal-actions"><button class="btn" data-modal="reset" type="button">Reset workspace</button><button class="btn primary" data-modal="ok">Save</button></div>`, form => {
      const name = form.name.value.trim();
      if (name) u.name = name;
      const st = $('.status-list button.on', els.modal)?.dataset.status;
      if (st) u.status = st;
      save();
      render();
    });
    $$('.status-list button', els.modal).forEach(b => b.addEventListener('click', () => {
      $$('.status-list button', els.modal).forEach(x => x.classList.toggle('on', x === b));
    }));
    $('[data-modal="reset"]', els.modal).addEventListener('click', () => {
      if (!confirm('Reset all messages and channels to the demo workspace?')) return;
      const name = me().name;
      state = seed(name);
      save();
      closeModal();
      ui.conv = 'general'; ui.section = 'teams'; ui.thread = null;
      render();
    });
  }

  function onboarding() {
    modal(`<h3>WELCOME TO HUDDLE</h3><p>Your team is already here. What should they call you?</p>
      <label class="field"><span class="label">Your name</span><input name="name" value="Tygo van Steenpaal" maxlength="40" required></label>
      <div class="modal-actions"><button class="btn primary" data-modal="ok">Join the team</button></div>`, form => {
      state = seed(form.name.value.trim() || 'Tygo van Steenpaal');
      save();
      render();
    }, { dismissable: false });
  }

  // ==========================================================================
  // Modal / toast / palette
  // ==========================================================================
  let modalCb = null;
  function modal(html, onOk, { dismissable = true } = {}) {
    els.modal.innerHTML = `<form class="modal-box" novalidate>${html}</form>`;
    els.modal.hidden = false;
    els.modal.dataset.dismissable = dismissable ? '1' : '';
    modalCb = onOk;
    const input = $('input:not([type=hidden]), select', els.modal);
    if (input) { input.focus(); if (input.select) input.select(); }
  }
  function closeModal() { els.modal.hidden = true; els.modal.innerHTML = ''; modalCb = null; }
  els.modal.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    const cb = modalCb;
    if (cb && cb(form) === false) return;
    if (modalCb === cb) closeModal();
  });
  els.modal.addEventListener('click', e => {
    const b = e.target.closest('[data-modal]');
    if (b?.dataset.modal === 'close') { e.preventDefault(); closeModal(); }
    if (b?.dataset.modal === 'ok') { e.preventDefault(); els.modal.querySelector('form').requestSubmit(); }
    if (e.target === els.modal && els.modal.dataset.dismissable) closeModal();
  });

  function toast(u, title, text, onClick) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `${u ? avatar(u, '', false) : `<span class="av" style="background:var(--accent);color:#fff">!</span>`}<div><b>${esc(title)}</b><span>${esc(text)}</span></div>`;
    el.addEventListener('click', () => { el.remove(); onClick?.(); });
    els.toasts.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  let palIndex = 0;
  function openPalette() {
    els.palette.hidden = false;
    els.paletteInput.value = '';
    palIndex = 0;
    renderPalette();
    els.paletteInput.focus();
  }
  function closePalette() { els.palette.hidden = true; }
  function renderPalette() {
    const q = els.paletteInput.value.trim().toLowerCase();
    const mark = s => {
      const e = esc(s);
      if (!q) return e;
      const i = s.toLowerCase().indexOf(q);
      if (i < 0) return e;
      return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
    };
    const results = [];
    for (const c of allChannels()) if (!q || c.name.includes(q)) results.push({ group: 'Channels', html: `<span class="hash">#</span><span>${mark(c.name)}<div class="pr-sub">${esc(c.team.name)}</div></span>`, go: () => openConv(c.id) });
    for (const u of state.users) {
      if (u.id === state.me || (q && !u.name.toLowerCase().includes(q))) continue;
      results.push({ group: 'People', html: `${avatar(u, 'sm')}<span>${mark(u.name)}<div class="pr-sub">${esc(u.title)}</div></span>`, go: () => {
        let dm = state.dms.find(d => d.members.includes(u.id));
        if (!dm) { dm = { id: 'dm-' + u.id, members: [state.me, u.id] }; state.dms.push(dm); state.messages[dm.id] = []; save(); }
        openConv(dm.id);
      } });
    }
    if (q.length >= 2) {
      for (const [conv, list] of Object.entries(state.messages)) {
        for (const m of list) {
          const hits = [m, ...(m.replies || [])].filter(x => x.text.toLowerCase().includes(q));
          for (const h of hits) {
            const info = convInfo(conv);
            if (!info) continue;
            const plain = h.text.replace(/```|\*\*|`/g, '').replace(/\s+/g, ' ');
            const i = plain.toLowerCase().indexOf(q);
            if (i < 0) continue;
            const snip = (i > 40 ? '...' : '') + plain.slice(Math.max(0, i - 40), i + 80);
            results.push({ group: 'Messages', html: `${avatar(user(h.author), 'sm', false)}<span>${mark(snip)}<div class="pr-sub">${esc(user(h.author)?.name || '')} in ${info.kind === 'channel' ? '#' : ''}${esc(info.name)}</div></span>`, go: () => openConv(conv, { scrollTo: m.id }) });
          }
        }
      }
    }
    const shown = results.slice(0, 40);
    palIndex = Math.min(palIndex, Math.max(0, shown.length - 1));
    let html = '', last = '';
    shown.forEach((r, i) => {
      if (r.group !== last) { html += `<div class="label">${r.group}</div>`; last = r.group; }
      html += `<button class="pr ${i === palIndex ? 'on' : ''}" data-i="${i}">${r.html}</button>`;
    });
    els.paletteResults.innerHTML = html || `<div class="palette-empty">Nothing found for "${esc(q)}".</div>`;
    els.paletteResults._results = shown;
  }
  els.paletteInput.addEventListener('input', () => { palIndex = 0; renderPalette(); });
  els.paletteInput.addEventListener('keydown', e => {
    const n = els.paletteResults._results?.length || 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = (palIndex + 1) % Math.max(1, n); renderPalette(); scrollPal(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = (palIndex - 1 + n) % Math.max(1, n); renderPalette(); scrollPal(); }
    if (e.key === 'Enter' && n) { const r = els.paletteResults._results[palIndex]; closePalette(); r.go(); }
  });
  const scrollPal = () => $('.pr.on', els.paletteResults)?.scrollIntoView({ block: 'nearest' });
  els.paletteResults.addEventListener('click', e => {
    const b = e.target.closest('.pr');
    if (!b) return;
    const r = els.paletteResults._results[+b.dataset.i];
    closePalette();
    r.go();
  });
  els.palette.addEventListener('click', e => { if (e.target === els.palette) closePalette(); });

  // ==========================================================================
  // Calls
  // ==========================================================================
  const call = { active: false, people: [], start: 0, timer: null, stream: null, screen: null, mic: true, cam: false, title: '' };

  function startCall(people, title) {
    if (call.active) return;
    Object.assign(call, { active: true, people, title, start: Date.now(), mic: true, cam: false, stream: null, screen: null });
    renderCall();
    call.timer = setInterval(tickCall, 500);
  }

  function renderCall() {
    const tiles = [
      `<div class="tile" id="tile-me">${call.stream && call.cam ? '' : avatar(me(), 'xl', false)}<div class="who">${call.mic ? '' : icon('mic-off')}You</div></div>`,
      ...call.people.map(id => {
        const u = user(id);
        return `<div class="tile" data-who="${id}">${avatar(u, 'xl', false)}<div class="who">${esc(u.name)}</div></div>`;
      }),
    ];
    if (call.screen) tiles.unshift(`<div class="tile" id="tile-screen" style="grid-column:1/-1"><div class="who">${icon('monitor-up')}Your screen</div></div>`);
    els.call.innerHTML = `<div class="call-head"><span class="rec"></span><strong>${esc(call.title)}</strong><span class="timer" id="callTimer">00:00</span></div>
      <div class="call-grid">${tiles.join('')}</div>
      <div class="call-bar">
        <button class="call-btn ${call.mic ? '' : 'off'}" data-call="mic"><span class="ic">${icon(call.mic ? 'mic' : 'mic-off')}</span>Mic</button>
        <button class="call-btn ${call.cam ? '' : 'off'}" data-call="cam"><span class="ic">${icon(call.cam ? 'video' : 'video-off')}</span>Camera</button>
        <button class="call-btn ${call.screen ? '' : ''}" data-call="screen"><span class="ic">${icon('monitor-up')}</span>${call.screen ? 'Stop share' : 'Share'}</button>
        <button class="call-btn leave" data-call="leave"><span class="ic">${icon('phone-off')}</span>Leave</button>
      </div>`;
    els.call.hidden = false;
    if (call.stream && call.cam) {
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = call.stream;
      $('#tile-me').prepend(v);
    }
    if (call.screen) {
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true; v.className = 'screen'; v.srcObject = call.screen;
      $('#tile-screen').prepend(v);
    }
    paintIcons();
    tickCall();
  }

  function tickCall() {
    if (!call.active) return;
    const s = Math.floor((Date.now() - call.start) / 1000);
    const t = $('#callTimer');
    if (t) t.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    // Others "speak" now and then.
    $$('.tile[data-who]', els.call).forEach(el => el.classList.toggle('speaking', Math.random() < 0.18));
  }

  async function toggleCam() {
    if (call.cam) {
      call.cam = false;
      call.stream?.getTracks().forEach(t => t.stop());
      call.stream = null;
      return renderCall();
    }
    try {
      call.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      call.cam = true;
    } catch {
      toast(null, 'Camera unavailable', 'Allow camera access in your browser to turn it on.');
    }
    renderCall();
  }

  async function toggleScreen() {
    if (call.screen) {
      call.screen.getTracks().forEach(t => t.stop());
      call.screen = null;
      return renderCall();
    }
    try {
      call.screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      call.screen.getVideoTracks()[0].addEventListener('ended', () => { call.screen = null; renderCall(); });
    } catch { /* user cancelled */ }
    renderCall();
  }

  function leaveCall() {
    const dur = Math.floor((Date.now() - call.start) / 1000);
    call.stream?.getTracks().forEach(t => t.stop());
    call.screen?.getTracks().forEach(t => t.stop());
    clearInterval(call.timer);
    if (call.people.length === 1) state.calls.push({ id: uid(), with: call.people[0], dir: 'out', ts: call.start, dur });
    Object.assign(call, { active: false, stream: null, screen: null });
    els.call.hidden = true;
    els.call.innerHTML = '';
    save();
    render();
  }

  els.call.addEventListener('click', e => {
    const b = e.target.closest('[data-call]');
    if (!b) return;
    const a = b.dataset.call;
    if (a === 'mic') { call.mic = !call.mic; renderCall(); }
    if (a === 'cam') toggleCam();
    if (a === 'screen') toggleScreen();
    if (a === 'leave') leaveCall();
  });

  // ==========================================================================
  // Composer behaviour
  // ==========================================================================
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  }

  let mentionPop = null;
  function closeMention() { mentionPop?.remove(); mentionPop = null; }
  function showMention(ta) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const m = before.match(/(^|\s)@(\w*)$/);
    if (!m) return closeMention();
    const q = m[2].toLowerCase();
    const list = state.users.filter(u => u.id !== state.me && u.name.toLowerCase().includes(q)).slice(0, 6);
    if (!list.length) return closeMention();
    closeMention();
    mentionPop = document.createElement('div');
    mentionPop.className = 'mention-pop';
    mentionPop.innerHTML = list.map((u, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-name="${esc(u.name.split(' ')[0])}">${avatar(u, 'sm')}${esc(u.name)}</button>`).join('');
    const r = ta.closest('.composer').getBoundingClientRect();
    mentionPop.style.left = r.left + 'px';
    mentionPop.style.bottom = (innerHeight - r.top + 6) + 'px';
    document.body.appendChild(mentionPop);
    mentionPop._ta = ta;
    mentionPop.addEventListener('mousedown', e => {
      e.preventDefault();
      const b = e.target.closest('button');
      if (b) insertMention(ta, b.dataset.name);
    });
  }
  function insertMention(ta, name) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret).replace(/@(\w*)$/, '@' + name + ' ');
    ta.value = before + ta.value.slice(caret);
    ta.selectionStart = ta.selectionEnd = before.length;
    closeMention();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  document.addEventListener('input', e => {
    const ta = e.target;
    if (ta.tagName !== 'TEXTAREA') return;
    autosize(ta);
    const comp = ta.closest('.composer');
    const send = comp && $('.send', comp);
    if (send) send.disabled = !ta.value.trim() && !(comp.dataset.where === 'main' && ui.pendingFiles.length);
    if (comp?.dataset.where) {
      showMention(ta);
      if (channel && comp.dataset.where === 'main') channel.postMessage({ type: 'typing', conv: ui.conv, from: tabId });
    }
  });

  document.addEventListener('keydown', e => {
    const ta = e.target;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); els.palette.hidden ? openPalette() : closePalette(); return; }
    if (e.key === 'Escape') {
      if (!els.palette.hidden) return closePalette();
      if (!els.modal.hidden && els.modal.dataset.dismissable) return closeModal();
      if (mentionPop) return closeMention();
      if (ui.pickFor) { ui.pickFor = null; return render(); }
      if (ui.editing) { ui.editing = null; return render(); }
      if (ui.thread) { ui.thread = null; return render(); }
    }
    if (ta.tagName !== 'TEXTAREA') return;
    if (mentionPop && mentionPop._ta === ta && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
      e.preventDefault();
      const items = $$('button', mentionPop);
      let i = items.findIndex(b => b.classList.contains('on'));
      if (e.key === 'ArrowDown') i = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') i = (i - 1 + items.length) % items.length;
      else return insertMention(ta, items[i].dataset.name);
      items.forEach((b, j) => b.classList.toggle('on', j === i));
      return;
    }
    const comp = ta.closest('.composer');
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (comp.dataset.edit) {
        const m = ta.closest('.msg');
        return saveEdit(m.dataset.conv, comp.dataset.edit, ta.value);
      }
      send(comp.dataset.where, ta.value);
    }
    if (e.key === 'ArrowUp' && !ta.value && comp.dataset.where === 'main') {
      const mine = (state.messages[ui.conv] || []).filter(m => m.author === state.me).pop();
      if (mine) { e.preventDefault(); ui.editing = mine.id; render(); focusEdit(); }
    }
  });

  function focusEdit() {
    const ta = $('[data-edit] textarea');
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    autosize(ta);
  }

  document.addEventListener('change', e => {
    if (e.target.dataset.action !== 'attach') return;
    const files = [...e.target.files];
    const maxSize = 1.5 * 1024 * 1024;
    const draft = $('textarea', e.target.closest('.composer'))?.value || '';
    Promise.all(files.map(f => new Promise(res => {
      if (f.size > maxSize) { toast(null, 'File too large', `${f.name} is over 1.5 MB.`); return res(null); }
      const r = new FileReader();
      r.onload = () => res({ name: f.name, size: f.size, type: f.type, data: r.result });
      r.onerror = () => res(null);
      r.readAsDataURL(f);
    }))).then(list => {
      ui.pendingFiles.push(...list.filter(Boolean));
      ui.restoreDraft = draft;
      renderMain();
      paintIcons();
      const ta = $('textarea', els.main);
      const sendBtn = $('.send', els.main);
      if (sendBtn) sendBtn.disabled = !ui.pendingFiles.length && !ta.value.trim();
      ta?.focus();
    });
  });

  // ==========================================================================
  // Click delegation
  // ==========================================================================
  document.addEventListener('click', e => {
    const railBtn = e.target.closest('.rail-btn[data-section]');
    if (railBtn) {
      ui.section = railBtn.dataset.section;
      ui.mobileConv = ui.section === 'activity' || ui.section === 'calls';
      if (ui.section === 'chat' && !convInfo(ui.conv)?.other) ui.conv = [...state.dms].sort((a, b) => (lastMessage(b.id)?.ts || 0) - (lastMessage(a.id)?.ts || 0))[0]?.id;
      if (ui.section === 'teams' && convInfo(ui.conv)?.kind !== 'channel') ui.conv = 'general';
      if (matchMedia('(max-width: 760px)').matches && (ui.section === 'chat' || ui.section === 'teams')) ui.mobileConv = false;
      ui.thread = null;
      return render();
    }
    if (e.target.closest('#meBtn')) return statusModal();

    if (ui.pickFor && !e.target.closest('.react-pick') && !e.target.closest('[data-action="pick"]')) { ui.pickFor = null; render(); }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const msgEl = el.closest('.msg');
    const conv = msgEl?.dataset.conv;
    const id = msgEl?.dataset.id;

    switch (a) {
      case 'open': openConv(el.dataset.id); break;
      case 'toggle-group': state.collapsed[el.dataset.id] = !state.collapsed[el.dataset.id]; save(false); renderSide(); paintIcons(); break;
      case 'palette': openPalette(); break;
      case 'new-channel': newChannel(); break;
      case 'new-dm': newDm(); break;
      case 'tab': ui.tab = el.dataset.id; renderMain(); paintIcons(); break;
      case 'back': ui.mobileConv = false; render(); break;
      case 'send': {
        const comp = el.closest('.composer');
        send(comp.dataset.where, $('textarea', comp).value);
        break;
      }
      case 'fmt': {
        const ta = $('textarea', el.closest('.composer'));
        const w = el.dataset.wrap;
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = ta.value.slice(s, en) || (w === '**' ? 'bold' : 'code');
        ta.value = ta.value.slice(0, s) + w + sel + w + ta.value.slice(en);
        ta.focus();
        ta.selectionStart = s + w.length; ta.selectionEnd = s + w.length + sel.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        break;
      }
      case 'mention': {
        const ta = $('textarea', el.closest('.composer'));
        const pre = ta.value && !/\s$/.test(ta.value) ? ' @' : '@';
        ta.value += pre;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        break;
      }
      case 'unpend': {
        const draft = $('textarea', els.main)?.value || '';
        ui.pendingFiles.splice(+el.dataset.i, 1);
        ui.restoreDraft = draft;
        renderMain(); paintIcons();
        break;
      }
      case 'pick': ui.pickFor = ui.pickFor === id ? null : id; render(); break;
      case 'react': toggleReaction(conv, id, el.dataset.rx); break;
      case 'thread': {
        const rootId = msgEl.dataset.thread ? ui.thread?.id : id;
        ui.thread = { conv, id: rootId || id };
        render();
        $('textarea', els.thread)?.focus();
        break;
      }
      case 'close-thread': ui.thread = null; render(); break;
      case 'edit': ui.editing = id; render(); focusEdit(); break;
      case 'delete': deleteMsg(conv, id); break;
      case 'copy': {
        const found = findMsg(conv, id);
        navigator.clipboard?.writeText(found?.msg.text || '').then(() => toast(null, 'Copied', 'Message text is on your clipboard.'), () => {});
        break;
      }
      case 'goto':
        openConv(el.dataset.conv, { scrollTo: el.dataset.id });
        if (el.dataset.thread) { ui.thread = { conv: el.dataset.conv, id: el.dataset.id }; render(); }
        break;
      case 'call': {
        const u = user(el.dataset.id);
        startCall([u.id], u.name);
        break;
      }
      case 'meet': {
        const info = convInfo(ui.conv);
        const online = state.users.filter(u => u.id !== state.me && u.status !== 'offline').map(u => u.id).slice(0, 4);
        startCall(online, `Meeting in #${info.name}`);
        break;
      }
    }
  });

  // Edit box blur saves nothing; Esc cancels (handled above).
  document.addEventListener('focusout', e => {
    if (e.target.tagName === 'TEXTAREA' && mentionPop?._ta === e.target) setTimeout(closeMention, 100);
  });

  // ==========================================================================
  // Boot
  // ==========================================================================
  load();
  if (!state || state.version !== 1) {
    state = seed('Tygo van Steenpaal');
    render();
    onboarding();
  } else {
    render();
  }

  // Keep relative times fresh.
  setInterval(() => { if (els.modal.hidden && !call.active) { renderSide(); renderRail(); paintIcons(); } }, 60 * 1000);

  window.__huddle = { get state() { return state; }, ui, openConv, send };
})();
