// BLOKSTORM - the game itself: ties input, rendering, the referee (sim) and the network together.
import * as THREE from 'three';
import { RULES, WORLD, PHYS, ITEMS, BLOCKS, CLASSES, DEFAULT_LOOK, LOOK, B, ABILITIES, PRICES, PAY, levelOf, xpForLevel } from './config.js';
import { World } from './world.js';
import { Renderer, makeItem, setItem, isBlockItem } from './render.js';
import { Avatar } from './avatar.js';
import { Controller, DEFAULT_BINDS, BIND_LABELS } from './player.js';
import { Sim } from './sim.js';
import { Net } from './net.js';
import { UI, keyName } from './ui.js';
import { sfx, setVolume, ambient } from './audio.js';
import { zoneRadius, distToMiddle, stepDrop, stepProj } from './shared.js';
import { angleLerp, clamp, roomCode } from './util.js';
import { blockAtlas, ATLAS_COLS } from './textures.js';

const { CX, CZ } = WORLD;
const ARROW_TIP = new THREE.Vector3(1, 1, 0).normalize(), TMP = new THREE.Vector3();
const STORE = 'blokstorm.profile';

class Game {
  constructor() {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    this.profile = { name: saved.name || `Speler${Math.floor(Math.random() * 900 + 100)}`, look: { ...DEFAULT_LOOK, ...(saved.look || {}) }, cls: CLASSES[saved.cls] ? saved.cls : 'bouwer' };
    this.settings = { sens: 1, vol: 0.5, scale: 1, fov: 80, ...(saved.settings || {}) };
    // older saves used the chunky pixel look as default; the sharp picture is the default now
    if (this.settings.v !== 3) { this.settings.scale = 1; this.settings.v = 3; }
    this.settings.keys = { ...DEFAULT_BINDS, ...(this.settings.keys || {}) };
    this.tipsSeen = new Set(saved.tips || []);
    this.stats = { games: 0, wins: 0, kills: 0, ...(saved.stats || {}) };
    this.airdrops = [];
    this.coins = saved.coins || 0; this.xp = saved.xp || 0;
    this.owned = { hairStyle: [0, 1, 2], cape: [0, 1], hat: [0], ...(saved.owned || {}) };
    // looks you already wore before the shop existed stay yours
    for (const k of Object.keys(PRICES)) if (!this.owned[k].includes(this.profile.look[k])) this.owned[k].push(this.profile.look[k]);
    this.map = 'torens';

    this.canvas = document.getElementById('game');
    this.r = new Renderer(this.canvas);
    this.r.setScale(this.settings.scale);
    setVolume(this.settings.vol);
    this.world = new World();
    this.ctl = new Controller(this.canvas);
    this.ctl.sens = this.settings.sens;
    this.ctl.binds = this.settings.keys;
    this.players = new Map();
    this.drops = new Map();
    this.projs = new Map();
    this.sim = null;
    this.screen = 'menu'; this.phase = 'lobby'; this.looksFrom = 'menu';
    this.slot = 0; this.fx = {}; this.breaking = null; this.charge = null; this.placeCd = 0; this.swingCd = 0; this.fell = false;
    this.poseAt = 0; this.matchT = 0; this.countdown = 0; this.spectate = null; this.specYaw = 0; this.specPitch = 0.3;
    this.lastTick = -1; this.zoneWarned = false;

    this.net = new Net({
      onEvent: (e) => this.onEvent(e),
      onPose: (map, from) => this.onPose(map, from),
      onIntent: (from, m) => this.sim && this.sim.intent(from, m),
      onHello: (from, info) => this.onHello(from, info),
      onSnap: (s) => this.onSnap(s),
      onLeave: (id) => this.sim && this.sim.removePlayer(id),
      onHostLost: () => this.toMenu('De host is weggegaan.'),
    });
    this.ui = new UI({
      solo: () => this.startSolo(), host: () => this.startHost(), join: (code) => this.startJoin(code),
      openLooks: () => this.openLooks(), closeLooks: () => this.closeLooks(), randomLook: () => this.randomLook(),
      leave: () => this.toMenu(''), ready: () => { const me = this.players.get(this.net.selfId); this.net.intent({ t: 'ready', on: !(me && me.ready) }); },
      start: () => this.net.intent({ t: 'start' }),
      bots: (d) => this.net.intent({ t: 'bots', n: [...this.players.values()].filter((p) => p.bot).length + d }),
      map: (id) => this.net.intent({ t: 'map', map: id }),
      cls: (id) => { this.profile.cls = id; this.save(); this.net.intent({ t: 'cls', cls: id }); },
      name: (v) => { this.profile.name = v.trim().slice(0, 14) || 'Speler'; this.save(); if (this.menuAvatar) this.menuAvatar.setName(this.profile.name); },
      resume: () => { this.ui.settings(false); if (this.screen === 'match' && this.phase !== 'end') this.ctl.lock(); },
      openSettings: () => this.ui.settings(true, false),
      resetKeys: () => { this.settings.keys = { ...DEFAULT_BINDS }; this.ctl.binds = this.settings.keys; this.save(); this.showKeys(); },
      closeInv: () => this.closeInventory(),
      invDrop: (i) => { if (i != null && this.me && this.me.inv[i]) this.net.intent({ t: 'drop', slot: i }); },
      setting: (k, v) => { this.settings[k] = v; this.save(); if (k === 'sens') this.ctl.sens = v; if (k === 'vol') setVolume(v); if (k === 'scale') this.r.setScale(v); },
    });
    this.ui.setProfile(this.profile, this.settings);
    this.showKeys();
    addEventListener('keydown', (e) => {
      if (this.invOpen && (e.code === this.ctl.binds.inventory || e.code === 'Escape')) { e.preventDefault(); this.closeInventory(); }
    });

    this.#viewmodel();
    this.canvas.addEventListener('click', () => {
      if (this.screen !== 'match' || this.phase === 'end') return;
      if (!this.ctl.locked) { this.ui.overlay('pause', false); this.ctl.lock(); }
    });
    document.addEventListener('pointerlockchange', () => {
      const playing = this.screen === 'match' && this.phase !== 'end';
      this.ui.lockHint(false);
      if (!this.ctl.locked && playing && !this.invOpen) this.ui.settings(true, true);
    });

    // Browsers pause animation frames in a hidden tab. If the host tabs away the round would freeze for everyone,
    // so a tiny worker keeps the referee ticking while this tab is hidden.
    try {
      const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
      let lastBg = performance.now();
      worker.onmessage = () => {
        const now = performance.now(), dt = Math.min(0.2, (now - lastBg) / 1000);
        lastBg = now;
        if (!document.hidden || !this.sim) return;
        this.sim.tick(dt);
        if (this.net.online) {
          const map = {};
          for (const b of this.sim.players.values()) if (b.bot && b.alive) map[b.id] = [b.pos.x, b.pos.y, b.pos.z, b.yaw, b.pitch, b.slot, b.flags];
          this.net.pose(map);
        }
      };
    } catch { /* no workers: the round only runs while the host tab is visible */ }

    this.showMenuScene();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  showKeys() {
    this.ui.buildKeys(this.settings.keys, BIND_LABELS, (action, code) => {
      // a key can only do one thing: the action that had it gets the old key of this one
      const other = Object.keys(this.settings.keys).find((a) => a !== action && this.settings.keys[a] === code);
      if (other) this.settings.keys[other] = this.settings.keys[action];
      this.settings.keys[action] = code;
      this.save(); this.showKeys();
    });
  }
  openInventory() {
    const me = this.me;
    if (!me || !me.alive) return;
    this.invOpen = true;
    this.ctl.unlock();
    this.ui.invPick = null;
    this.showInventory();
  }
  showInventory() {
    if (!this.invOpen || !this.me) return;
    this.ui.inventory(this.me.inv, this.slot, (a, b) => this.net.intent({ t: 'swap', a, b }));
  }
  closeInventory() {
    if (!this.invOpen) return;
    this.invOpen = false;
    this.ui.inventory(null);
    if (this.screen === 'match' && this.phase !== 'end') this.ctl.lock();
  }
  save() { localStorage.setItem(STORE, JSON.stringify({ ...this.profile, settings: this.settings, tips: [...this.tipsSeen], stats: this.stats, coins: this.coins, xp: this.xp, owned: this.owned })); }
  /** Explain something the first time it matters. Every tip is shown once. */
  tip(key, text) { if (this.tipsSeen.has(key) || performance.now() < (this.tipBusy || 0)) return; this.tipsSeen.add(key); this.tipBusy = performance.now() + 9500; this.save(); this.ui.tip(text); }
  get me() { return this.players.get(this.net.selfId); }

  // ---- menu, looks, lobby -----------------------------------------------------------------------------------------
  showMenuScene() {
    this.screen = 'menu'; this.phase = 'lobby';
    this.clearMatch();
    this.world.generateLobby(); this.r.clearWorld();
    for (const p of this.players.values()) this.removeAvatar(p);
    this.players.clear();
    if (!this.menuAvatar) { this.menuAvatar = new Avatar(this.profile.look, this.profile.name); this.r.scene.add(this.menuAvatar.group); }
    this.menuAvatar.group.visible = true;
    this.menuAvatar.setLook(this.profile.look);
    this.menuAvatar.group.position.set(CX + 0.5, 21, CZ + 0.5);
    ambient(false);
    const lvl = levelOf(this.xp), base = xpForLevel(lvl), next = xpForLevel(lvl + 1);
    this.ui.progress(lvl, this.coins, (this.xp - base) / (next - base));
    this.ui.show('menu'); this.ui.overlay('pause', false); this.ui.overlay('end', false);
    this.ui.stats(this.stats.games ? `Gespeeld ${this.stats.games} · Gewonnen ${this.stats.wins} · Kills ${this.stats.kills}` : '');
  }
  toMenu(msg) {
    this.ctl.unlock();
    this.net.leave(); this.sim = null;
    this.showMenuScene();
    this.ui.menuMsg(msg);
  }
  openLooks() {
    this.looksFrom = this.screen;
    this.screen = 'looks';
    for (const p of this.players.values()) if (p.avatar) p.avatar.group.visible = false;
    this.menuAvatar.group.visible = true; this.menuAvatar.setLook(this.profile.look);
    this.menuAvatar.group.position.set(CX + 0.5, 21, CZ + 0.5);
    const shop = () => ({ owned: this.owned, coins: this.coins });
    const change = (key, i) => {
      const price = PRICES[key] ? PRICES[key][i] : 0;
      if (price && !this.owned[key].includes(i)) {
        // show it on the character first; a second click on the same option buys it
        if (this.tryOn !== `${key}${i}`) { this.tryOn = `${key}${i}`; this.menuAvatar.setLook({ ...this.profile.look, [key]: i }); this.ui.menuMsg(''); sfx('tick'); return; }
        if (this.coins < price) { sfx('lose'); this.ui.buildLooks(this.profile.look, change, shop()); document.getElementById('lookCoins').textContent = `Te weinig munten: dit kost ${price}, je hebt ${this.coins}.`; return; }
        this.coins -= price; this.owned[key].push(i); sfx('win');
      }
      this.tryOn = null;
      this.profile.look[key] = i; this.save(); this.menuAvatar.setLook(this.profile.look); this.ui.buildLooks(this.profile.look, change, shop());
    };
    this.lookChange = change; this.lookShop = shop;
    this.ui.buildLooks(this.profile.look, change, shop());
    document.getElementById('lookCoins').textContent += ' Klik een optie met een prijs om hem te passen, klik nog een keer om te kopen.';
    this.ui.show('looks');
  }
  randomLook() {
    // only from what you own
    for (const k of Object.keys(DEFAULT_LOOK)) { const pool = this.owned[k] || [...LOOK[k].keys()]; this.profile.look[k] = pool[Math.floor(Math.random() * pool.length)]; }
    this.save(); this.menuAvatar.setLook(this.profile.look); this.ui.buildLooks(this.profile.look, this.lookChange, this.lookShop());
  }
  closeLooks() {
    if (this.looksFrom === 'lobby') {
      this.net.intent({ t: 'look', look: this.profile.look, name: this.profile.name });
      this.enterLobby();
    } else { this.screen = 'menu'; this.ui.show('menu'); }
  }
  hello() { return { name: this.profile.name, look: this.profile.look, cls: this.profile.cls }; }

  makeSim() {
    this.sim = new Sim(this.world, (e, to) => this.net.event(e, to));
    this.sim.hostId = this.net.selfId;
    this.sim.addPlayer(this.net.selfId, this.hello());
  }
  startSolo() {
    this.net.offline();
    this.makeSim();
    this.sim.setBots(5);
    this.enterLobby();
  }
  async startHost() {
    this.ui.menuMsg('Lobby maken...');
    try {
      const code = roomCode();
      await this.net.connect(code, true, () => this.hello());
      this.makeSim();
      this.enterLobby();
      this.ui.menuMsg('');
    } catch (err) { this.ui.menuMsg(`Verbinden lukt niet: ${err.message || err}`); }
  }
  async startJoin(code) {
    if (!/^[A-Z]{4}$/.test(code)) { this.ui.menuMsg('Vul een code van 4 letters in.'); return; }
    this.ui.menuMsg('Lobby zoeken...');
    try {
      this.sim = null;
      await this.net.connect(code, false, () => this.hello());
      clearTimeout(this.joinTimer);
      this.joinTimer = setTimeout(() => { if (this.screen === 'menu') this.toMenu('Geen lobby gevonden met die code.'); }, 20000);
    } catch (err) { this.ui.menuMsg(`Verbinden lukt niet: ${err.message || err}`); }
  }
  onHello(from, info) {
    if (!this.sim) return;
    if (this.sim.players.size >= RULES.maxPlayers) {
      const bot = [...this.sim.players.values()].find((p) => p.bot);
      if (!bot || this.sim.phase !== 'lobby') return;
      this.sim.players.delete(bot.id);
    }
    this.sim.addPlayer(from, info || {});
    this.net.snap(from, this.sim.snapshot());
  }
  onSnap(s) {
    clearTimeout(this.joinTimer);
    this.ui.menuMsg('');
    if (s.map) this.map = s.map;
    this.applyRoster(s.players);
    if (s.phase === 'lobby') { this.enterLobby(); return; }
    // joined while a round is running: watch until it ends
    this.beginMatch(s.seed, {});
    this.world.applyDiffs(s.diffs);
    for (const d of s.drops) this.addDrop(d);
    this.phase = 'play'; this.matchT = s.time;
    for (const p of s.players) { const m = this.players.get(p.id); if (m) { m.alive = p.alive; if (m.avatar) m.avatar.group.visible = p.alive; } }
    this.startSpectate();
  }

  enterLobby() {
    this.screen = 'lobby'; this.phase = 'lobby';
    this.clearMatch();
    this.world.generateLobby(); this.r.clearWorld();
    if (this.menuAvatar) this.menuAvatar.group.visible = false;
    this.ui.show('lobby'); this.ui.overlay('end', false); this.ui.overlay('pause', false);
    this.layoutLobby();
    this.refreshLobby();
  }
  refreshLobby() {
    if (this.screen !== 'lobby') return;
    this.ui.setLobby({ code: this.net.code, players: [...this.players.values()], me: this.net.selfId, isHost: this.net.isHost, online: this.net.online, map: this.map });
  }
  layoutLobby() {
    const list = [...this.players.values()];
    list.forEach((p, i) => {
      if (!p.avatar) return;
      p.avatar.group.visible = true;
      p.avatar.group.position.set(CX + (i - (list.length - 1) / 2) * Math.min(1.45, 8.4 / list.length), 21, CZ + 0.5);
      p.avatar.group.rotation.set(0, Math.PI, 0);
      p.avatar.hold(CLASSES[p.cls].kit[0][0]);
    });
  }

  // ---- players ----------------------------------------------------------------------------------------------------
  applyRoster(list) {
    const seen = new Set();
    for (const d of list) {
      seen.add(d.id);
      let p = this.players.get(d.id);
      if (!p) {
        p = { ...d, inv: Array(9).fill(null), armor: 0, pose: null, cur: { x: CX, y: 21, z: CZ, yaw: 0, pitch: 0 }, speed: 0, flags: 2, slot: 0 };
        p.avatar = new Avatar(d.look, d.name);
        this.r.scene.add(p.avatar.group);
        this.players.set(d.id, p);
      } else {
        if (JSON.stringify(p.look) !== JSON.stringify(d.look)) p.avatar.setLook(d.look);
        if (p.name !== d.name) p.avatar.setName(d.name);
        Object.assign(p, { name: d.name, cls: d.cls, look: d.look, ready: d.ready, bot: d.bot, kills: d.kills });
        if (this.phase === 'lobby') { p.alive = d.alive; p.hp = d.hp; p.maxHp = d.maxHp; }
      }
    }
    for (const [id, p] of this.players) if (!seen.has(id)) { this.removeAvatar(p); this.players.delete(id); }
    if (this.screen === 'lobby') { this.layoutLobby(); this.refreshLobby(); }
  }
  removeAvatar(p) { if (p.shadow) { this.r.scene.remove(p.shadow); p.shadow = null; } if (p.avatar) { this.r.scene.remove(p.avatar.group); p.avatar.dispose(); p.avatar = null; } }

  onPose(map, from) {
    if (!map) return;
    for (const id of Object.keys(map)) {
      if (id === this.net.selfId) continue;
      // a player may only report their own position; the host also reports the bots
      if (id !== from && from !== this.net.hostId) continue;
      const p = this.players.get(id);
      if (p) p.pose = map[id];
      if (this.sim && id === from) this.sim.setPose(id, map[id]);
    }
  }

  // ---- match ------------------------------------------------------------------------------------------------------
  clearMatch() {
    for (const d of this.drops.values()) this.r.scene.remove(d.mesh);
    for (const p of this.projs.values()) this.r.scene.remove(p.mesh);
    this.drops.clear(); this.projs.clear();
    this.r.setZone(0); this.r.setTarget(null);
    this.vm.visible = false;
    this.ui.clearHud();
    this.airdrops = []; this.swingT = 1;
    for (const p of this.players.values()) { if (p.shadow) p.shadow.visible = false; p.dying = 0; }
    this.spectate = null; this.breaking = null; this.charge = null; this.eating = null; this.blocking = false; this.fx = {};
  }
  beginMatch(seed, slots) {
    this.screen = 'match'; this.phase = 'countdown'; this.countdown = RULES.countdown; this.matchT = 0; this.lastTick = -1;
    this.clearMatch();
    this.r.clearWorld();
    if (this.world.seed !== seed || !this.net.isHost) this.world.generate(seed, this.map);
    if (this.menuAvatar) this.menuAvatar.group.visible = false;
    this.fell = false; this.zoneWarned = false; this.slot = 0; this.stamina = 100; this.tired = false; this.abReady = 0; this.noFall = false;
    for (const p of this.players.values()) {
      const s = this.world.spawns[slots[p.id]];
      p.alive = !!s; p.inv = Array(9).fill(null); p.armor = 0;
      const c = CLASSES[p.cls]; p.maxHp = c.hp || 20; p.hp = p.maxHp;
      if (s) { p.cur = { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: 0 }; p.pose = null; }
      if (p.avatar) { p.avatar.group.visible = !!s && p.id !== this.net.selfId; p.avatar.group.rotation.set(0, 0, 0); p.dying = 0; }
      if (s && p.id === this.net.selfId) this.ctl.spawn(s.x, s.y, s.z, s.yaw);
    }
    this.ui.show('hud'); this.ui.overlay('end', false); this.ui.overlay('pause', false);
    ambient(true);
    const me = this.me;
    this.played = !!(me && me.alive);
    if (me && me.alive) {
      this.ui.setHp(me.hp, me.maxHp); this.ui.setArmor(0); this.ui.setInv(me.inv, 0);
      this.ctl.lock();
      setTimeout(() => { if (this.screen === 'match' && !this.ctl.locked) this.ui.lockHint(true); }, 400);
    }
  }
  startSpectate() {
    const alive = [...this.players.values()].filter((p) => p.alive && p.id !== this.net.selfId);
    this.spectate = alive.length ? alive[0].id : null;
    this.vm.visible = false; this.r.setTarget(null);
    this.ui.spec(this.spectate ? this.players.get(this.spectate).name : 'Niemand meer over');
  }

  onEvent(e) {
    const me = this.me, mine = e.id === this.net.selfId;
    const p = e.id != null ? this.players.get(e.id) : null;
    switch (e.t) {
      case 'roster': if (e.map) this.map = e.map; this.applyRoster(e.players); break;
      case 'start': this.map = e.map || 'klassiek'; this.beginMatch(e.seed, e.slots); sfx('tick'); break;
      case 'go': this.phase = 'play'; this.matchT = 0; this.ui.center('GO', 'Bouw naar het midden', 1400); sfx('go'); break;
      case 'lobby': this.closeInventory(); this.ctl.unlock(); this.enterLobby(); break;
      case 'inv':
        if (!p) break;
        p.inv = e.inv; p.armor = e.armor;
        if (mine) { this.ui.setInv(p.inv, this.slot, this.popSlot ?? -1); this.popSlot = -1; this.ui.setArmor(p.armor); this.showInventory(); }
        break;
      case 'drip': {
        const i = me ? me.inv.findIndex((s) => s && s.id === e.item) : -1;
        if (me) this.ui.setInv(me.inv, this.slot, i);
        sfx('drip');
        break;
      }
      case 'hp':
        if (!p) break;
        if (e.hp < p.hp) {
          if (e.blocked && (mine || e.by === this.net.selfId)) sfx('block');
          if (e.crit) { this.r.burst(p.cur.x, p.cur.y + 1.4, p.cur.z, '#e8c63a', 12, 4); if (e.by === this.net.selfId) sfx('crit'); }
          if (mine) { this.ui.hurt(); sfx('hurt'); if (e.src !== 'heal') this.hurtRoll = 1; if (e.kb) { this.ctl.vel.x = e.kb[0]; this.ctl.vel.y = e.kb[1]; this.ctl.vel.z = e.kb[2]; this.ctl.ground = false; } }
          else { p.avatar && p.avatar.flash(); this.r.burst(p.cur.x, p.cur.y + 1.1, p.cur.z, '#e5484d', 6, 2.5);
            if (e.src !== 'zone') this.r.popText(String(Math.max(1, Math.round(p.hp - e.hp))), p.cur.x, p.cur.y + 2.1, p.cur.z, e.crit ? '#e8c63a' : '#ffffff'); if (e.by === this.net.selfId) { sfx('hit'); this.ui.hitMark(); } }
        }
        p.hp = e.hp;
        if (mine) this.ui.setHp(p.hp, p.maxHp);
        break;
      case 'die': {
        if (!p) break;
        p.alive = false;
        if (p.avatar && p.id !== this.net.selfId && p.avatar.group.visible && e.cause !== 'void') { p.dying = 0.7; p.avatar.flash(); } else if (p.avatar) p.avatar.group.visible = false;
        this.r.burst(p.cur.x, p.cur.y + 1, p.cur.z, '#e9e7e1', 24, 5);
        const killer = e.by ? this.players.get(e.by) : null;
        if (killer) killer.kills = (killer.kills || 0) + 1;
        const how = e.cause === 'void' ? 'viel in de leegte' : e.cause === 'zone' ? 'bleef buiten de cirkel' : e.cause === 'val' ? 'viel te hard' : e.cause === 'weg' ? 'is weggegaan' : 'is uitgeschakeld';
        this.ui.feed(killer ? [[killer.name], e.cause === 'void' ? ' duwde ' : ' versloeg ', [p.name], e.cause === 'void' ? ' de leegte in' : ''] : [[p.name], ` ${how}`]);
        if (mine) { this.closeInventory(); sfx('die'); this.ui.center('UITGESCHAKELD', killer ? `Door ${killer.name}` : how, 2600); this.ctl.vel = { x: 0, y: 0, z: 0 }; this.startSpectate(); }
        else if (e.by === this.net.selfId) { sfx('kill'); this.ui.center('', `${p.name} uitgeschakeld`, 1800); }
        if (this.spectate === e.id) this.startSpectate();
        break;
      }
      case 'blk': {
        const was = this.world.get(e.x, e.y, e.z);
        this.world.set(e.x, e.y, e.z, e.b);
        if (e.chest) this.airdrops = this.airdrops.filter((a) => a.x !== e.x || a.z !== e.z || a.y !== e.y);
        if (e.chest) { this.r.burst(e.x + 0.5, e.y + 1.1, e.z + 0.5, '#e8c63a', 18, 4); sfx('chest'); }
        else if (was !== e.b && e.by !== undefined) {
          const near = Math.hypot(e.x - this.r.camera.position.x, e.z - this.r.camera.position.z) < 24;
          if (e.b === 0) { this.r.burst(e.x + 0.5, e.y + 0.5, e.z + 0.5, tileColor(e.was || was), 10, 3); if (near) sfx('break'); }
          else if (near && e.by !== this.net.selfId) sfx('place');
        }
        break;
      }
      case 'drop+': this.addDrop(e.d); break;
      case 'drop-': {
        const d = this.drops.get(e.id);
        if (!d) break;
        if (e.left > 0) d.n = e.left; else { this.r.scene.remove(d.mesh); this.drops.delete(e.id); }
        if (e.by === this.net.selfId) sfx('pickup');
        break;
      }
      case 'proj+': {
        const pr = { ...e.p };
        pr.mesh = makeItem(pr.kind);
        pr.mesh.scale.setScalar(pr.kind === 'arrow' ? 0.75 : 0.45);
        this.r.scene.add(pr.mesh); this.projs.set(pr.id, pr);
        if (pr.owner === this.net.selfId || Math.hypot(pr.x - this.r.camera.position.x, pr.z - this.r.camera.position.z) < 16) sfx(pr.kind === 'arrow' ? 'bow' : 'throw');
        break;
      }
      case 'proj=': { const pr = this.projs.get(e.id); if (pr) { pr.x = e.x; pr.y = e.y; pr.z = e.z; pr.stuck = true; } break; }
      case 'proj-': {
        const pr = this.projs.get(e.id);
        if (!pr) break;
        this.r.scene.remove(pr.mesh); this.projs.delete(e.id);
        this.r.burst(e.x, e.y, e.z, pr.kind === 'warp' ? '#6a52c8' : '#c9ced2', 5, 2);
        break;
      }
      case 'boom': {
        const pr = this.projs.get(e.id);
        if (pr) { this.r.scene.remove(pr.mesh); this.projs.delete(e.id); }
        for (const [x, y, z] of e.cells) this.world.set(x, y, z, 0);
        this.r.burst(e.x, e.y, e.z, '#e8862e', e.small ? 18 : 40, e.small ? 5 : 9); this.r.burst(e.x, e.y, e.z, '#2a2c2b', e.small ? 8 : 30, 6);
        sfx('boom');
        break;
      }
      case 'swing': if (p && !mine && p.avatar) p.avatar.attack(); break;
      case 'fx': if (mine) this.fx[e.effect] = this.matchT + e.time; break;
      case 'used': if (mine) sfx('eat'); break;
      case 'tp':
        if (mine) { this.ctl.pos = { x: e.x, y: e.y, z: e.z }; this.ctl.vel = { x: 0, y: 0, z: 0 }; this.ctl.peak = e.y; }
        else if (p) { p.cur.x = e.x; p.cur.y = e.y; p.cur.z = e.z; }
        this.r.burst(e.x, e.y + 1, e.z, '#6a52c8', 24, 4); sfx('warp');
        break;
      case 'air': this.airdrops.push({ x: e.x, y: e.y, z: e.z }); this.ui.center('', 'Luchtdrop geland. Kijk op je kaart (geel)', 3200); sfx('chest'); this.r.burst(e.x + 0.5, e.y + 1, e.z + 0.5, '#e8c63a', 30, 6); break;
      case 'ab': {
        if (!p) break;
        this.r.burst(p.cur.x, p.cur.y + 1, p.cur.z, '#20e7b7', 18, 4);
        if (mine) { this.abReady = this.matchT + e.cd; sfx('warp'); if (e.vel) { this.ctl.vel.x = e.vel[0]; this.ctl.vel.y = e.vel[1]; this.ctl.vel.z = e.vel[2]; this.ctl.ground = false; } if (e.cls === 'verkenner') this.noFall = true; }
        else if (p.avatar) p.avatar.attack();
        break;
      }
      case 'wind': {
        const pr = this.projs.get(e.id);
        if (pr) { this.r.scene.remove(pr.mesh); this.projs.delete(e.id); }
        this.r.burst(e.x, e.y, e.z, '#e9fbff', 30, 7); this.r.burst(e.x, e.y, e.z, '#8fd3e2', 16, 5); sfx('wind');
        break;
      }
      case 'pull': if (mine && e.by) this.ui.center('', 'Je wordt naar een speler getrokken', 900);
        if (mine) { this.ctl.vel.x = e.vel[0]; this.ctl.vel.y = e.vel[1]; this.ctl.vel.z = e.vel[2]; this.ctl.ground = false; this.noFall = true; sfx('throw'); } break;
      case 'totem': if (p) { this.r.burst(p.cur.x, p.cur.y + 1.2, p.cur.z, '#e8c63a', 40, 6); sfx('win'); if (mine) this.ui.center('TWEEDE KANS', 'Je amulet heeft je gered', 2200); } break;
      case 'gen': { const g = this.world.generator; if (g) this.r.burst(g.x, g.y, g.z, '#20e7b7', 14, 3); break; }
      case 'end': {
        this.phase = 'end';
        this.invOpen = false; this.ui.inventory(null);
        this.ctl.unlock(); this.ui.overlay('pause', false);
        const win = e.winner ? this.players.get(e.winner) : null;
        const iWon = e.winner === this.net.selfId;
        sfx(iWon ? 'win' : 'lose');
        let pay = '';
        if (this.played) {
          this.played = false;
          const kills = (this.me && this.me.kills) || 0, place = e.rank.findIndex((r) => r.id === this.net.selfId);
          const earned = PAY.play + kills * PAY.kill + (iWon ? PAY.win : 0) + (place >= 0 && place < e.rank.length / 2 ? PAY.topHalf : 0);
          const before = levelOf(this.xp);
          this.coins += earned; this.xp += earned;
          this.stats.games++; if (iWon) this.stats.wins++; this.stats.kills += kills;
          this.save();
          pay = `+${earned} munten` + (levelOf(this.xp) > before ? ` · Level ${levelOf(this.xp)} bereikt` : '');
        }
        this.ui.end(iWon ? 'Jij wint' : win ? `${win.name} wint` : 'Niemand wint', 'Ronde voorbij', e.rank, this.net.selfId, pay);
        break;
      }
    }
  }

  addDrop(src) {
    const d = { ...src };
    d.mesh = makeItem(d.item);
    d.mesh.scale.setScalar(isBlockItem(d.item) ? 0.55 : 0.5);
    this.r.scene.add(d.mesh);
    this.drops.set(d.id, d);
  }

  // ---- first person hand ------------------------------------------------------------------------------------------
  #viewmodel() {
    this.vm = new THREE.Group();
    this.vmItem = makeItem('planks');
    this.vmArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.55), new THREE.MeshBasicMaterial({ color: '#e0ac7e', fog: false }));
    this.vm.add(this.vmItem, this.vmArm);
    this.vm.visible = false;
    this.r.handScene.add(this.vm);
    this.vmSwing = 0; this.vmHeld = undefined; this.vmDip = 0;
  }
  updateViewmodel(dt, held) {
    const id = held ? held.id : null;
    if (id !== this.vmHeld) { this.vmHeld = id; this.vmDip = 1; if (id) setItem(this.vmItem, id); }
    this.vmItem.visible = !!id; this.vmArm.visible = !id;
    this.vmArm.material.color.set(LOOK.skin[this.profile.look.skin % LOOK.skin.length]);
    this.vmSwing = Math.max(0, this.vmSwing - dt * 4.2);
    this.vmDip = Math.max(0, this.vmDip - dt * 5);
    const s = Math.sin(this.vmSwing * Math.PI), bob = Math.sin(this.ctl.bob) * 0.012 * Math.min(1, this.ctl.speed / 3);
    const pull = this.charge != null ? Math.min(1, this.charge) * 0.12 : 0;
    this.vm.position.set(0.56 - s * 0.3 - pull * 0.5, -0.42 - this.vmDip * 0.35 + bob - s * 0.12 + pull * 0.2, -0.95 + s * 0.15 + pull * 0.6);
    this.vm.position.x += this.swayX || 0; this.vm.position.y += (this.swayY || 0) - Math.max(0, -this.ctl.vel.y) * 0.004;
    this.vm.rotation.set(-s * 1.1, s * 0.5 + (this.swayX || 0) * 1.5, s * 0.3);
    if (this.blocking) { this.vm.position.set(0.22, -0.3, -0.8); this.vm.rotation.set(0.15, 0.5, 0.75); }
    if (this.eating != null) { const m = Math.sin(performance.now() / 45) * 0.025; this.vm.position.set(0.12, -0.3 + m, -0.7); this.vm.rotation.set(0.2, -0.5, 0.1); }
    if (id && isBlockItem(id)) { this.vmItem.scale.setScalar(0.62); this.vmItem.position.set(0, -0.04, 0); this.vmItem.rotation.set(0.12, 0.7, 0); }
    else { this.vmItem.scale.setScalar(0.5); this.vmItem.position.set(0.05, 0.04, 0); this.vmItem.rotation.set(0, 2.5, 0.12); }
    this.vmArm.position.set(0.02, -0.06, 0.1); this.vmArm.rotation.set(0.55, 0.25, 0);
  }

  // ---- per frame --------------------------------------------------------------------------------------------------
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    try {
      if (this.sim && !document.hidden) this.sim.tick(dt);
      if (this.screen === 'match') this.updateMatch(dt);
      else this.updateLobbyScene(dt, now / 1000);
      this.r.syncWorld(this.world, this.screen === 'match' ? 8 : 200);
      this.r.render(dt);
    } catch (err) {
      console.error(err);
      this.ui.fatal(String(err && err.stack || err));
      this.frame = () => {};
    }
  }

  updateLobbyScene(dt, t) {
    const cam = this.r.camera;
    if (cam.fov !== 70) { cam.fov = 70; cam.updateProjectionMatrix(); }
    if (this.screen === 'lobby') {
      cam.position.set(CX + 0.5 + Math.sin(t * 0.25) * 0.5, 22.9, CZ + 8.8);
      cam.lookAt(CX + 0.5, 21.9, CZ + 0.5);
      for (const p of this.players.values()) if (p.avatar) p.avatar.update(dt, { speed: 0, ground: true, sneak: false, pitch: 0 });
    } else {
      const looks = this.screen === 'looks';
      const off = looks ? -1.25 : -1.5, d = looks ? 3.5 : 4.6;
      cam.position.set(CX + 0.5 + off, 22.25, CZ + 0.5 + d);
      cam.lookAt(CX + 0.5 + off, 21.95, CZ + 0.5);
      if (this.menuAvatar) {
        this.menuAvatar.group.rotation.y = looks ? Math.PI + t * 0.9 : Math.PI - 0.35 + Math.sin(t * 0.6) * 0.3;
        this.menuAvatar.update(dt, { speed: looks ? 2.2 : 0, ground: true, sneak: false, pitch: 0 });
        this.menuAvatar.hold(looks ? null : CLASSES[this.profile.cls].kit[0][0]);
      }
    }
  }

  updateMatch(dt) {
    const me = this.me, cam = this.r.camera, ctl = this.ctl;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const n = Math.max(1, Math.ceil(this.countdown));
      if (n !== this.lastTick) { this.lastTick = n; this.ui.center(String(n), 'Maak je klaar', 1100); sfx('tick'); }
    } else if (this.phase === 'play') this.matchT += dt;

    const playing = me && me.alive && this.phase !== 'end';
    if (playing) {
      const c = CLASSES[me.cls];
      ctl.update(dt, this.world, {
        speed: (c.speed || 1) * (this.fx.speed > this.matchT ? 1.35 : 1) * (this.blocking ? 0.55 : 1), jump: (c.jump || 1) * (this.fx.jump > this.matchT ? 1.4 : 1),
        frozen: this.phase === 'countdown', sprint: !this.tired, slowfall: this.fx.slowfall > this.matchT,
      });
      // stamina: sprinting uses it up, standing or walking brings it back
      const moving = ctl.sprint && ctl.speed > PHYS.walk * 0.8;
      if (moving) this.stamina -= RULES.staminaDrain * dt; else this.stamina += RULES.staminaGain * dt * (ctl.speed < 0.5 ? 1.4 : 1);
      if (ctl.jumped && ctl.sprint) this.stamina -= RULES.staminaJump;
      this.stamina = clamp(this.stamina, 0, 100);
      if (this.stamina <= 0) this.tired = true; else if (this.stamina >= RULES.staminaBack) this.tired = false;
      this.ui.setStamina(this.stamina / 100, this.tired);
      if (this.tired) this.tip('stamina', 'Je stamina is op (de gele bliksems rechts). Loop even gewoon, dan kun je daarna weer rennen.');
      if (this.phase === 'countdown') { const s = this.world.spawns.find((sp) => Math.hypot(sp.x - ctl.pos.x, sp.z - ctl.pos.z) < 3); if (s && ctl.pos.y < s.y - 0.01) ctl.pos.y = s.y; }
      if (ctl.pos.y < RULES.voidY && !this.fell) { this.fell = true; this.net.intent({ t: 'fell' }); }
      const [ex, ey, ez] = ctl.eye();
      this.landDip = Math.max(0, (this.landDip || 0) - dt * 1.6);
      cam.position.set(ex, ey + Math.abs(Math.sin(ctl.bob)) * 0.045 * Math.min(1, ctl.speed / 3) - Math.sin(Math.min(1, this.landDip * 4) * Math.PI) * 0.12, ez);
      // a footstep each time the walk cycle passes a step; dust while sprinting
      const stepNo = Math.floor(ctl.bob / Math.PI);
      if (stepNo !== this.stepNo) { this.stepNo = stepNo; if (ctl.ground && ctl.speed > 1.2 && !ctl.sneak) { sfx('step'); if (ctl.sprint) this.r.burst(ctl.pos.x, ctl.pos.y + 0.05, ctl.pos.z, '#d8d8d2', 2, 1.2); } }
      // the hand lags a little behind the view when you turn
      const dyaw = ctl.yaw - (this.lastYaw ?? ctl.yaw), dpitch = ctl.pitch - (this.lastPitch ?? ctl.pitch);
      this.lastYaw = ctl.yaw; this.lastPitch = ctl.pitch;
      this.swayX = clamp((this.swayX || 0) + dyaw * 0.35, -0.09, 0.09) * Math.max(0, 1 - dt * 9);
      this.swayY = clamp((this.swayY || 0) - dpitch * 0.35, -0.07, 0.07) * Math.max(0, 1 - dt * 9);
      // the camera tips over for a moment when you are hit
      this.hurtRoll = Math.max(0, (this.hurtRoll || 0) - dt * 3.4);
      cam.rotation.set(ctl.pitch, ctl.yaw, Math.sin(this.hurtRoll * Math.PI) * 0.03);
      // the view widens a little while sprinting
      const fov = this.settings.fov + (ctl.sprint && ctl.speed > PHYS.walk ? 4 : 0) + (this.fx.speed > this.matchT ? 2 : 0);
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 8); cam.updateProjectionMatrix(); }
      me.cur.x = ctl.pos.x; me.cur.y = ctl.pos.y; me.cur.z = ctl.pos.z; me.cur.yaw = ctl.yaw;
      this.vm.visible = true;
      this.updateViewmodel(dt, me.inv[this.slot]);
      if (this.phase === 'play') this.handleInput(dt, me);
      else ctl.take();
    } else {
      ctl.take().forEach(([a]) => { if (a === 'primary') this.nextSpectate(); });
      this.updateSpectate(dt);
    }

    // send my position, and the bots when I am the host
    this.poseAt -= dt;
    if (this.poseAt <= 0 && this.net.online) {
      this.poseAt = 1 / 14;
      const map = {};
      const r2 = (v) => Math.round(v * 100) / 100;
      if (playing) map[this.net.selfId] = [r2(ctl.pos.x), r2(ctl.pos.y), r2(ctl.pos.z), r2(ctl.yaw), r2(ctl.pitch), this.slot, (ctl.sneak ? 1 : 0) | (ctl.ground ? 2 : 0) | (this.blocking ? 4 : 0)];
      if (this.sim) for (const b of this.sim.players.values()) if (b.bot && b.alive) map[b.id] = [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z), r2(b.yaw), r2(b.pitch), b.slot, b.flags];
      this.net.pose(map);
    }
    if (this.sim && playing) this.sim.setPose(this.net.selfId, [ctl.pos.x, ctl.pos.y, ctl.pos.z, ctl.yaw, ctl.pitch, this.slot, this.blocking ? 4 : 0]);

    // other players
    for (const p of this.players.values()) {
      if (p.id === this.net.selfId || !p.avatar) continue;
      if (p.dying > 0) {
        p.dying -= dt;
        p.avatar.group.rotation.z = Math.min(1, (0.7 - p.dying) / 0.35) * 1.5;
        p.avatar.update(dt, { speed: 0, ground: true, pitch: 0 });
        if (p.dying <= 0) { p.avatar.group.visible = false; p.avatar.group.rotation.z = 0; }
        if (p.shadow) p.shadow.visible = false;
        continue;
      }
      let pose = p.pose;
      if (this.sim && p.bot) { const b = this.sim.players.get(p.id); if (b) pose = [b.pos.x, b.pos.y, b.pos.z, b.yaw, b.pitch, b.slot, b.flags]; }
      if (pose && p.alive) {
        const k = Math.min(1, dt * 14), ox = p.cur.x, oz = p.cur.z;
        if (Math.hypot(pose[0] - p.cur.x, pose[1] - p.cur.y, pose[2] - p.cur.z) > 6) { p.cur.x = pose[0]; p.cur.y = pose[1]; p.cur.z = pose[2]; }
        p.cur.x += (pose[0] - p.cur.x) * k; p.cur.y += (pose[1] - p.cur.y) * k; p.cur.z += (pose[2] - p.cur.z) * k;
        p.cur.yaw = angleLerp(p.cur.yaw, pose[3], k); p.cur.pitch += (pose[4] - p.cur.pitch) * k;
        p.slot = pose[5]; p.flags = pose[6];
        const sp = Math.hypot(p.cur.x - ox, p.cur.z - oz) / Math.max(dt, 1e-3);
        p.speed += (sp - p.speed) * Math.min(1, dt * 10);
      }
      p.avatar.group.position.set(p.cur.x, p.cur.y, p.cur.z);
      p.avatar.group.rotation.y = p.cur.yaw;
      // shadow on the first block below the feet
      if (!p.shadow) p.shadow = this.r.makeShadow();
      let sy = -1;
      if (p.alive) for (let k = 0, fy = Math.floor(p.cur.y + 0.2); k < 7; k++) if (this.world.solid(Math.floor(p.cur.x), fy - k, Math.floor(p.cur.z))) { sy = fy - k + 1; break; }
      p.shadow.visible = sy >= 0 && p.avatar.group.visible;
      if (p.shadow.visible) { p.shadow.position.set(p.cur.x, sy + 0.02, p.cur.z); const f = Math.max(0.35, 1 - (p.cur.y - sy) * 0.18); p.shadow.scale.setScalar(f); p.shadow.material.opacity = 0.3 * f; }
      const held = p.inv[p.slot];
      p.avatar.hold(held ? held.id : null);
      p.avatar.update(dt, { speed: p.speed, ground: !!(p.flags & 2), sneak: !!(p.flags & 1), block: !!(p.flags & 4), pitch: p.cur.pitch });
    }

    // loot and flying things
    const t = performance.now() / 1000;
    for (const d of this.drops.values()) {
      stepDrop(this.world, d, dt);
      d.mesh.position.set(d.x, d.y + 0.2 + Math.sin(t * 3 + d.id) * 0.08, d.z);
      d.mesh.rotation.y = t * 1.6 + d.id;
    }
    for (const pr of this.projs.values()) {
      if (stepProj(this.world, pr, dt)) pr.stuck = true;
      pr.mesh.position.set(pr.x, pr.y, pr.z);
      if (pr.kind === 'arrow') {
        // the arrow sprite points to its top right corner: turn that corner into the flight direction
        const sp = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
        pr.mesh.quaternion.setFromUnitVectors(ARROW_TIP, TMP.set(pr.vx / sp, pr.vy / sp, pr.vz / sp));
      } else if (!pr.stuck) pr.mesh.rotation.set(t * 9, t * 7, 0);
    }

    // the circle and the display
    const radius = zoneRadius(this.matchT), closing = this.matchT > RULES.zoneDelay;
    // the wall is faint from far away and gets clearer as you come close to it
    const toWall = Math.abs(radius - distToMiddle(cam.position.x, cam.position.z));
    this.r.setZone(this.phase === 'countdown' ? zoneRadius(0) : radius, closing, t, (closing ? 0.1 : 0.03) + 0.34 * clamp(1 - toWall / 16, 0, 1));
    if (closing && !this.zoneWarned) { this.zoneWarned = true; this.ui.center('', 'De cirkel sluit', 2400); sfx('zone'); }
    const alive = [...this.players.values()].filter((p) => p.alive).length;
    const left = Math.max(0, RULES.zoneDelay - this.matchT);
    this.ui.setTop(alive, me ? me.kills : 0, closing ? 'Cirkel' : 'Cirkel sluit over', closing ? `${Math.round(radius)} m` : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`, closing);
    this.ui.setDrip(this.phase === 'play' ? (this.matchT % RULES.dripEvery) / RULES.dripEvery : 0);
    this.ui.warn(!!playing && this.phase === 'play' && distToMiddle(ctl.pos.x, ctl.pos.z) > radius);
    const view = playing ? { x: ctl.pos.x, z: ctl.pos.z } : this.players.get(this.spectate)?.cur;
    this.ui.radar(view, playing ? ctl.yaw : (view && view.yaw) || 0, radius, closing, this.world.spawns, this.airdrops, Math.max(zoneRadius(0), 14));
    const tab = this.ctl.down('board');
    if (tab !== this.boardOn || (tab && now2() - (this.boardAt || 0) > 500)) {
      this.boardOn = tab; this.boardAt = now2();
      this.ui.board(tab ? [...this.players.values()].sort((a, b) => (b.alive - a.alive) || ((b.kills || 0) - (a.kills || 0))).map((p) => ({ name: p.name, kills: p.kills, alive: p.alive, me: p.id === this.net.selfId })) : null);
    }
    const fxList = [];
    if (this.fx.speed > this.matchT) fxList.push(`Snel ${Math.ceil(this.fx.speed - this.matchT)}`);
    if (this.fx.slowfall > this.matchT) fxList.push(`Zweven ${Math.ceil(this.fx.slowfall - this.matchT)}`);
    if (this.fx.shield > this.matchT) fxList.push(`Schild ${Math.ceil(this.fx.shield - this.matchT)}`);
    if (this.fx.power > this.matchT) fxList.push(`Kracht ${Math.ceil(this.fx.power - this.matchT)}`);
    if (this.fx.jump > this.matchT) fxList.push(`Sprong ${Math.ceil(this.fx.jump - this.matchT)}`);
    this.ui.setEffects(fxList);
  }

  handleInput(dt, me) {
    const ctl = this.ctl, world = this.world;
    const [ex, ey, ez] = ctl.eye(), [dx, dy, dz] = ctl.dir();
    this.placeCd -= dt; this.swingCd -= dt;
    this.swingT = Math.min(1, this.swingT + dt / ((me.inv[this.slot] && ITEMS[me.inv[this.slot].id].swing) || RULES.swingTime));
    this.ui.swing(this.swingT);
    let held = me.inv[this.slot], def = held && ITEMS[held.id];
    const target = world.raycast(ex, ey, ez, dx, dy, dz, RULES.reach);

    for (const [action, arg] of ctl.take()) {
      if (action === 'slot' || action === 'scroll') {
        this.slot = action === 'slot' ? arg : (this.slot + arg + 9) % 9;
        this.net.intent({ t: 'slot', slot: this.slot });
        this.ui.setInv(me.inv, this.slot); this.charge = null; this.breaking = null; this.eating = null;
        held = me.inv[this.slot]; def = held && ITEMS[held.id];
      } else if (action === 'drop') { if (held) this.net.intent({ t: 'drop', slot: this.slot }); }
      else if (action === 'bounce') sfx('warp');
      else if (action === 'land' && (this.noFall || this.fx.slowfall > this.matchT)) { this.noFall = false; sfx('land'); }
      else if (action === 'land') { this.net.intent({ t: 'fall', d: arg }); if (arg > 0.9) { sfx('land'); this.landDip = Math.min(0.25, 0.08 + arg * 0.03); } }
      else if (action === 'inventory') this.openInventory();
      else if (action === 'primary') {
        if (this.swingCd > 0 || this.blocking) continue;
        this.swingCd = 0.07; this.vmSwing = 1; this.swingT = 0;
        // is another player in front of the crosshair, closer than the block behind them?
        const reach = (def && def.reach) || RULES.meleeReach;
        let best = null, bestT = target ? Math.min(target.dist, reach) : reach;
        for (const p of this.players.values()) {
          if (!p.alive || p.id === this.net.selfId) continue;
          const tHit = rayBox(ex, ey, ez, dx, dy, dz, p.cur);
          if (tHit != null && tHit < bestT) { bestT = tHit; best = p; }
        }
        if (best) this.net.intent({ t: 'hit', target: best.id, sprint: ctl.sprint, crit: !ctl.ground && ctl.vel.y < -0.5 }); else this.net.intent({ t: 'swing' });
        sfx('swing');
      } else if (action === 'secondary') {
        if (target && world.get(target.x, target.y, target.z) === B.CHEST) this.net.intent({ t: 'open', x: target.x, y: target.y, z: target.z });
        else if (def && def.kind === 'bow') { if (me.inv.some((s) => s && s.id === 'arrow')) this.charge = 0; else this.ui.center('', 'Geen pijlen', 900); }
        else if (def && def.kind === 'block') this.placeBlock(me, target);
        else if (def && (def.kind === 'food' || def.kind === 'potion')) {
          // eating takes a moment: keep the button down
          if (def.heal && !def.effect && me.hp >= me.maxHp) this.ui.center('', 'Je levens zijn al vol', 1000); else this.eating = 0;
        } else if (def && def.kind !== 'melee' && def.kind !== 'tool' && def.kind !== 'ammo') this.net.intent({ t: 'use', slot: this.slot, pos: [ex, ey, ez], dir: [dx, dy, dz] });
      } else if (action === 'release') {
        if (this.charge != null && def && def.kind === 'bow') this.net.intent({ t: 'use', slot: this.slot, charge: Math.min(1, this.charge), pos: [ex, ey, ez], dir: [dx, dy, dz] });
        this.charge = null;
      }
    }

    // keep the right button down to build a bridge fast
    if (ctl.right && def && def.kind === 'block' && this.placeCd <= 0) this.placeBlock(me, target);
    if (this.charge != null) { if (!ctl.right) this.charge = null; else this.charge += dt / 0.9; }
    if (this.eating != null) {
      if (!ctl.right || !def || (def.kind !== 'food' && def.kind !== 'potion')) this.eating = null;
      else {
        const before = this.eating;
        this.eating += dt / RULES.eatTime;
        if (Math.floor(before * 4) !== Math.floor(this.eating * 4)) sfx('dig');
        if (this.eating >= 1) { this.net.intent({ t: 'use', slot: this.slot }); this.eating = null; }
      }
    }
    this.blocking = ctl.right && !!def && def.kind === 'melee';
    // first round explanations
    const blocks = me.inv.reduce((n, s) => n + (s && ITEMS[s.id].kind === 'block' ? s.n : 0), 0);
    const mid = distToMiddle(ctl.pos.x, ctl.pos.z);
    if (this.matchT > 1) this.tip('start', 'Elke 4 seconden krijg je een nieuw item. Blokken heb je nodig om naar het midden te bouwen.');
    if (blocks >= 6) this.tip('bridge2', 'Brug bouwen: kijk vooruit naar waar je heen wilt, houd de rechtermuisknop ingedrukt en loop gewoon naar voren. De blokken komen vanzelf voor je voeten.');
    if (mid < 26 && this.world.chests.length) this.tip('chest', 'Op de kleine eilanden staan kisten. Kijk ernaar en klik rechts om ze te openen.');
    if (def && def.kind === 'melee') this.tip('block', 'Met een zwaard in je hand: links slaan, rechts vasthouden om te blokkeren. Blokkeren halveert de schade.');
    if (me.hp < me.maxHp - 5 && me.inv.some((s) => s && ITEMS[s.id].heal)) this.tip('eat', 'Je bent gewond. Kies eten of een geneesdrank en houd de rechtermuisknop vast.');
    if (this.swingT < 1) this.tip('swing', 'Het balkje onder je vizier laadt op na elke slag. Wacht tot het vol is: dan doet je klap de volle schade.');
    if (this.airdrops.length) this.tip('air', 'Er is een luchtdrop geland: een kist met topspullen. Het gele blokje op je kaart wijst de plek aan.');
    if (mid < 10) this.tip('gen', 'De generator in het midden spuugt de beste loot uit. Pak het voordat een ander het doet.');
    if (this.matchT > RULES.zoneDelay - 15) this.tip('zone', 'De cirkel gaat zo sluiten. Buiten de rode wand verlies je levens, dus ga naar het midden.');
    const bar = this.charge != null ? this.charge : this.eating;
    this.ui.charge(bar != null ? Math.min(1, bar) : null);

    // hold the left button on a block to break it
    if (ctl.left && target && BLOCKS[world.get(target.x, target.y, target.z)].hard > 0) {
      const b = this.breaking;
      if (!b || b.x !== target.x || b.y !== target.y || b.z !== target.z) this.breaking = { x: target.x, y: target.y, z: target.z, p: 0, tick: 0 };
      const hard = BLOCKS[world.get(target.x, target.y, target.z)].hard, mine = def && def.mine ? def.mine : 1;
      this.breaking.p += dt * mine / hard;
      this.breaking.tick -= dt;
      if (this.breaking.tick <= 0) { this.breaking.tick = 0.22; this.vmSwing = 1; sfx('dig'); }
      if (this.breaking.p >= 1) {
        this.net.intent({ t: 'break', x: target.x, y: target.y, z: target.z });
        if (!this.net.isHost) world.set(target.x, target.y, target.z, 0);
        this.breaking = null;
      }
    } else this.breaking = null;
    this.r.setTarget(target, this.breaking ? this.breaking.p : 0);
  }

  /**
   * Building made easy: near an edge the block goes in front of your feet, in the direction you look, so you
   * can hold the button and walk forward. Otherwise the block goes where the crosshair points, as usual.
   */
  placeBlock(me, target) {
    if (this.placeCd > 0) return;
    const c = this.ctl.pos, w = this.world;
    const fy = Math.floor(c.y + 0.001) - 1;
    const hx = -Math.sin(this.ctl.yaw), hz = -Math.cos(this.ctl.yaw);
    let cell = null, px = Math.floor(c.x), pz = Math.floor(c.z);
    for (let d = 0.3; d <= 2.6 && !cell; d += 0.15) {
      const x = Math.floor(c.x + hx * d), z = Math.floor(c.z + hz * d);
      if (x === px && z === pz) continue;
      if (!w.get(x, fy, z)) { if (w.get(px, fy, pz) || w.get(x + 1, fy, z) || w.get(x - 1, fy, z) || w.get(x, fy, z + 1) || w.get(x, fy, z - 1)) cell = [x, fy, z]; else break; }
      px = x; pz = z;
    }
    // use the bridge spot when you look into the air, or down at the floor you are standing on
    const lookingAtFloor = target && target.ny === 1 && target.y === fy;
    if (cell && (!target || lookingAtFloor) && this.ctl.pitch > -1.2 && w.inside(...cell)) {
      this.placeCd = 0.16; this.vmSwing = 1; sfx('place');
      const held = me.inv[this.slot];
      if (!this.net.isHost) w.set(cell[0], cell[1], cell[2], ITEMS[held.id].block);
      this.net.intent({ t: 'place', x: cell[0], y: cell[1], z: cell[2], slot: this.slot });
      return;
    }
    this.tryPlace(me, target);
  }

  tryPlace(me, target) {
    if (!target || this.placeCd > 0) return;
    const x = target.x + target.nx, y = target.y + target.ny, z = target.z + target.nz;
    const c = this.ctl.pos;
    if (!this.world.inside(x, y, z) || this.world.get(x, y, z)) return;
    // not inside my own body
    if (c.x + 0.3 > x && c.x - 0.3 < x + 1 && c.z + 0.3 > z && c.z - 0.3 < z + 1 && c.y + PHYS.height > y && c.y < y + 1) return;
    this.placeCd = 0.17;
    this.vmSwing = 1; sfx('place');
    const held = me.inv[this.slot];
    if (!this.net.isHost) this.world.set(x, y, z, ITEMS[held.id].block);
    this.net.intent({ t: 'place', x, y, z, slot: this.slot });
  }

  nextSpectate() {
    const alive = [...this.players.values()].filter((p) => p.alive && p.id !== this.net.selfId);
    if (!alive.length) return;
    const i = alive.findIndex((p) => p.id === this.spectate);
    this.spectate = alive[(i + 1) % alive.length].id;
    this.ui.spec(this.players.get(this.spectate).name);
  }
  updateSpectate(dt) {
    const cam = this.r.camera, t = this.players.get(this.spectate);
    this.vm.visible = false;
    this.specYaw += dt * 0.25;
    const c = t ? t.cur : { x: CX, y: 24, z: CZ };
    const d = t ? 5 : 26;
    cam.position.set(c.x + Math.sin(this.specYaw) * d, c.y + 3.2 + (t ? 0 : 10), c.z + Math.cos(this.specYaw) * d);
    cam.lookAt(c.x, c.y + 1.2, c.z);
  }
}

const now2 = () => performance.now();

/** Distance along a ray to a standing player box, or null. */
function rayBox(ox, oy, oz, dx, dy, dz, c) {
  const g = 0.12;
  const min = [c.x - 0.3 - g, c.y - g, c.z - 0.3 - g], max = [c.x + 0.3 + g, c.y + 1.8 + g, c.z + 0.3 + g];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let t0 = 0, t1 = 1e9;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < min[i] || o[i] > max[i]) return null; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** Average colour of a block, for the particles when it breaks. */
const tileCache = new Map();
function tileColor(id) {
  if (!BLOCKS[id]) return '#8b8f8d';
  if (tileCache.has(id)) return tileCache.get(id);
  const tile = BLOCKS[id].side, g = blockAtlas().getContext('2d');
  const d = g.getImageData((tile % ATLAS_COLS) * 16 + 6, Math.floor(tile / ATLAS_COLS) * 16 + 9, 1, 1).data;
  const c = `rgb(${d[0]},${d[1]},${d[2]})`;
  tileCache.set(id, c);
  return c;
}

document.fonts.ready.then(() => {
  try { window.game = new Game(); }
  catch (err) { console.error(err); document.getElementById('fatalText').textContent = String(err && err.stack || err); document.getElementById('fatal').hidden = false; }
});
