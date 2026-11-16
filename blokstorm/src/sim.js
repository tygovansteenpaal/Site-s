// BLOKSTORM - the referee. Only the host runs this. It owns hit points, inventories, loot, the circle and the
// bots, and tells everyone what happened through small events. Players send it requests ("intents").
import { RULES, WORLD, ITEMS, BLOCKS, CLASSES, DRIP_LOOT, GEN_LOOT, CHEST_LOOT, B, FIST, BOT_NAMES, DEFAULT_LOOK, LOOK, CLASS_IDS, PHYS, BOT, ABILITIES, MAPS } from './config.js';
import { pickWeighted, clamp } from './util.js';
import { zoneRadius, distToMiddle, stepDrop, stepProj, segHitsBox } from './shared.js';
import { updateBot } from './bots.js';

let nextId = 1;

export class Sim {
  /** emit(event, toPlayerId?) sends an event to everyone or to one player. */
  constructor(world, emit) {
    this.world = world;
    this.emit = emit;
    this.players = new Map();
    this.drops = new Map();
    this.projs = new Map();
    this.phase = 'lobby';
    this.t = 0; this.timer = 0; this.dripAt = 0; this.genAt = 0; this.zoneTick = 0;
    this.order = [];
    this.hostId = null;
    this.map = 'torens';
  }

  // ---- roster -----------------------------------------------------------------------------------------------------
  addPlayer(id, info, bot = false) {
    if (this.players.has(id)) return;
    this.players.set(id, {
      id, bot, name: String(info.name || 'Speler').slice(0, 14), cls: CLASSES[info.cls] ? info.cls : 'bouwer',
      look: { ...DEFAULT_LOOK, ...(info.look || {}) }, ready: bot,
      hp: 20, maxHp: 20, armor: 0, alive: false, inv: Array(9).fill(null), slot: 0,
      pos: { x: WORLD.CX, y: 21, z: WORLD.CZ }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, flags: 0,
      kills: 0, hitAt: -9, useAt: -9, breakAt: -9, lastBy: null, lastByAt: -99, fx: {}, ai: null,
    });
    this.roster();
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive && this.phase !== 'lobby') this.kill(p, null, 'weg');
    this.players.delete(id);
    this.roster();
  }
  setBots(n) {
    const bots = [...this.players.values()].filter((p) => p.bot);
    const humans = this.players.size - bots.length;
    n = clamp(n, 0, RULES.maxPlayers - humans);
    while (bots.length > n) this.players.delete(bots.pop().id);
    for (let i = bots.length; i < n; i++) {
      const used = new Set([...this.players.values()].map((p) => p.name));
      const name = BOT_NAMES.find((b) => !used.has(b)) || `Bot ${i + 1}`;
      const look = {};
      for (const k of Object.keys(DEFAULT_LOOK)) look[k] = Math.floor(Math.random() * LOOK[k].length);
      this.addPlayer(`bot${nextId++}`, { name, look, cls: CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)] }, true);
    }
    this.roster();
  }
  rosterData() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, look: p.look, ready: p.ready, bot: p.bot, alive: p.alive, hp: p.hp, maxHp: p.maxHp, kills: p.kills }));
  }
  roster() { this.emit({ t: 'roster', players: this.rosterData(), host: this.hostId, map: this.map }); }

  /** Everything a player who joins late needs to catch up. */
  snapshot() {
    return {
      phase: this.phase, time: this.t, seed: this.world.seed, map: this.map, diffs: this.phase === 'lobby' ? [] : [...this.world.diffs],
      players: this.rosterData(), host: this.hostId,
      drops: [...this.drops.values()].map((d) => ({ ...d })),
    };
  }

  // ---- intents ----------------------------------------------------------------------------------------------------
  intent(id, m) {
    const p = this.players.get(id);
    if (!p || !m) return;
    switch (m.t) {
      case 'cls': if (this.phase === 'lobby' && CLASSES[m.cls]) { p.cls = m.cls; this.roster(); } break;
      case 'look': p.look = { ...DEFAULT_LOOK, ...m.look }; if (m.name) p.name = String(m.name).slice(0, 14); this.roster(); break;
      case 'ready': if (this.phase === 'lobby') { p.ready = !!m.on; this.roster(); } break;
      case 'map': if (id === this.hostId && this.phase === 'lobby' && MAPS[m.map]) { this.map = m.map; this.roster(); } break;
      case 'bots': if (id === this.hostId && this.phase === 'lobby') this.setBots(m.n | 0); break;
      case 'start': if (id === this.hostId) this.start(); break;
      case 'slot': p.slot = clamp(m.slot | 0, 0, 8); break;
      case 'hit': this.melee(p, this.players.get(m.target), { sprint: !!m.sprint, crit: !!m.crit }); break;
      case 'swap': { const a = m.a | 0, b = m.b | 0; if (a >= 0 && a < 9 && b >= 0 && b < 9 && a !== b) { [p.inv[a], p.inv[b]] = [p.inv[b], p.inv[a]]; this.sendInv(p); } break; }
      case 'swing': p.swingAt = this.t; this.emit({ t: 'swing', id }); break;
      case 'place': this.place(p, m.x | 0, m.y | 0, m.z | 0, m.slot | 0); break;
      case 'break': this.breakBlock(p, m.x | 0, m.y | 0, m.z | 0); break;
      case 'use': this.use(p, m); break;
      case 'open': this.openChest(p, m.x | 0, m.y | 0, m.z | 0); break;
      case 'drop': this.dropSlot(p, m.slot | 0); break;
      case 'fall': if (p.alive && this.phase === 'play' && m.d > RULES.fallSafe) this.damage(p, Math.min(20, Math.floor(m.d - RULES.fallSafe + 1)), this.credit(p), 'val', null, true); break;
      case 'fell': if (p.alive && this.phase === 'play') this.kill(p, this.credit(p), 'void'); break;
    }
  }
  setPose(id, a) {
    const p = this.players.get(id);
    if (!p || p.bot || !Array.isArray(a)) return;
    p.pos.x = +a[0] || 0; p.pos.y = +a[1] || 0; p.pos.z = +a[2] || 0; p.yaw = +a[3] || 0; p.pitch = +a[4] || 0; p.slot = clamp(a[5] | 0, 0, 8); p.flags = a[6] | 0;
  }

  // ---- match flow -------------------------------------------------------------------------------------------------
  start() {
    if (this.phase !== 'lobby') return;
    const list = [...this.players.values()].slice(0, RULES.maxPlayers);
    if (!list.length) return;
    const seed = (Math.random() * 2 ** 31) | 0;
    this.world.generate(seed, this.map);
    this.drops.clear(); this.projs.clear(); this.order = [];
    const slots = [...Array(RULES.maxPlayers).keys()].sort(() => Math.random() - 0.5);
    const start = {};
    list.forEach((p, i) => {
      const c = CLASSES[p.cls], s = this.world.spawns[slots[i]];
      p.maxHp = c.hp || 20; p.hp = p.maxHp; p.armor = 0; p.alive = true; p.kills = 0; p.fx = {};
      p.inv = Array(9).fill(null); p.slot = 0; p.lastBy = null; p.hitAt = -9; p.regenAt = 0; p.useAt = -9; p.breakAt = -9; p.hurtUntil = 0; p.swingAt = -9; p.abAt = 0;
      for (const [item, n] of c.kit) this.give(p, item, n, false);
      this.give(p, 'planks', RULES.startBlocks, false);
      p.pos = { x: s.x, y: s.y, z: s.z }; p.vel = { x: 0, y: 0, z: 0 }; p.yaw = s.yaw; p.pitch = 0;
      p.ai = p.bot ? { wait: BOT.wait[0] + Math.random() * (BOT.wait[1] - BOT.wait[0]), cd: 1, place: 0, stuck: 0, side: 0, use: 0, shoot: 1 + Math.random() * 2, jumpCd: 0 } : null;
      start[p.id] = slots[i];
    });
    this.phase = 'countdown'; this.timer = RULES.countdown; this.t = 0;
    this.dripAt = RULES.dripEvery; this.genAt = RULES.genEvery; this.zoneTick = 0; this.airAt = RULES.airEvery;
    this.emit({ t: 'start', seed, slots: start, map: this.map });
    this.roster();
    for (const p of list) this.sendInv(p);
  }

  tick(dt) {
    if (this.phase === 'countdown') {
      this.timer -= dt;
      if (this.timer <= 0) { this.phase = 'play'; this.t = 0; this.emit({ t: 'go' }); }
      return;
    }
    if (this.phase === 'end') {
      this.timer -= dt;
      if (this.timer <= 0) this.toLobby();
      return;
    }
    if (this.phase !== 'play') return;
    this.t += dt;

    if (this.t >= this.dripAt) {
      this.dripAt += RULES.dripEvery;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        let [item, n] = pickWeighted(DRIP_LOOT);
        // no pile of the same weapon: roll again when the player already owns it
        for (let k = 0; k < 4 && !ITEMS[item].stack && this.findSlot(p, item) >= 0; k++) [item, n] = pickWeighted(DRIP_LOOT);
        const mul = ITEMS[item].kind === 'block' ? (CLASSES[p.cls].blockMul || 1) : 1;
        this.give(p, item, n * mul);
        this.emit({ t: 'drip', item, n: n * mul }, p.id);
      }
    }
    if (this.t >= this.genAt) {
      this.genAt += RULES.genEvery;
      const g = this.world.generator;
      let near = 0;
      for (const d of this.drops.values()) if (Math.hypot(d.x - g.x, d.z - g.z) < 3.5) near++;
      if (near < RULES.genMaxDrops) {
        const [item, n] = pickWeighted(GEN_LOOT);
        const a = Math.random() * 6.28;
        this.spawnDrop(item, n, g.x, g.y, g.z, Math.cos(a) * 1.6, 4.5, Math.sin(a) * 1.6);
        this.emit({ t: 'gen' });
      }
    }

    // air drop: a chest with generator loot lands on a small platform somewhere inside the circle
    if (this.t >= this.airAt) {
      this.airAt += RULES.airEvery;
      const zr = zoneRadius(this.t), r = Math.min(zr - 5, 11 + Math.random() * 11);
      if (r > 9) {
        const a = Math.random() * 6.28, x = Math.round(WORLD.CX + Math.cos(a) * r), z = Math.round(WORLD.CZ + Math.sin(a) * r), y = RULES.spawnY + 1;
        const put = (bx, by, bz, id) => { if (this.world.set(bx, by, bz, id)) this.emit({ t: 'blk', x: bx, y: by, z: bz, b: id }); };
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!this.world.get(x + dx, y, z + dz)) put(x + dx, y, z + dz, B.WOOL);
        put(x, y + 1, z, B.CHEST);
        this.world.chests.push({ x, y: y + 1, z, open: false, rare: true });
        this.emit({ t: 'air', x, y: y + 1, z });
      }
    }

    for (const d of this.drops.values()) {
      stepDrop(this.world, d, dt);
      if (d.y < RULES.voidY - 10) { this.drops.delete(d.id); this.emit({ t: 'drop-', id: d.id }); continue; }
      if (d.age < 0.7) continue;
      for (const p of this.players.values()) {
        if (!p.alive || (d.from === p.id && d.age < 1.6)) continue;
        if (Math.hypot(p.pos.x - d.x, p.pos.z - d.z) > 1.25 || d.y < p.pos.y - 0.9 || d.y > p.pos.y + 2.1) continue;
        const left = this.give(p, d.item, d.n);
        if (left === d.n) continue;
        if (left > 0) d.n = left; else this.drops.delete(d.id);
        this.emit({ t: 'drop-', id: d.id, by: p.id, left });
        break;
      }
    }

    for (const pr of this.projs.values()) this.stepProjectile(pr, dt);

    // the circle
    this.zoneTick += dt;
    if (this.zoneTick >= 1) {
      this.zoneTick -= 1;
      const r = zoneRadius(this.t);
      const dps = RULES.zoneDps * (1 + Math.max(0, this.t - RULES.zoneDelay) / 50);
      for (const p of this.players.values()) if (p.alive && distToMiddle(p.pos.x, p.pos.z) > r) this.damage(p, dps, null, 'zone', null, true);
    }

    for (const p of this.players.values()) {
      for (const k of Object.keys(p.fx)) if (p.fx[k] <= this.t) delete p.fx[k];
      // hit points slowly come back when you stay out of trouble
      if (p.alive && p.hp < p.maxHp && this.t >= (p.regenAt || RULES.regenAfter)) { p.regenAt = this.t + RULES.regenEvery; p.hp = Math.min(p.maxHp, p.hp + 1); this.emit({ t: 'hp', id: p.id, hp: p.hp, src: 'heal' }); }
      if (p.bot && p.alive) updateBot(this, p, dt);
    }
  }

  toLobby() {
    this.phase = 'lobby';
    for (const p of this.players.values()) { p.alive = false; p.ready = p.bot; }
    this.drops.clear(); this.projs.clear();
    this.emit({ t: 'lobby' });
    this.roster();
  }
  checkEnd() {
    if (this.phase !== 'play') return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    const total = this.order.length + alive.length;
    if (alive.length > 1 || (alive.length === 1 && total === 1)) return;
    const win = alive[0] || null;
    if (win) this.order.push(win.id);
    this.phase = 'end'; this.timer = RULES.endScreen;
    const rank = [...this.order].reverse().map((id) => { const p = this.players.get(id); return p ? { id, name: p.name, kills: p.kills } : null; }).filter(Boolean);
    this.emit({ t: 'end', winner: win ? win.id : null, rank });
  }

  // ---- inventory --------------------------------------------------------------------------------------------------
  /** Put items in a player's inventory. Returns how many did not fit. */
  give(p, item, n, send = true) {
    const max = ITEMS[item].stack || 1;
    for (const s of p.inv) if (n > 0 && s && s.id === item && s.n < max) { const k = Math.min(n, max - s.n); s.n += k; n -= k; }
    for (let i = 0; i < 9 && n > 0; i++) if (!p.inv[i]) { const k = Math.min(n, max); p.inv[i] = { id: item, n: k }; n -= k; }
    if (send) this.sendInv(p);
    return n;
  }
  take(p, slot, n = 1) {
    const s = p.inv[slot];
    if (!s) return false;
    s.n -= n;
    if (s.n <= 0) p.inv[slot] = null;
    this.sendInv(p);
    return true;
  }
  count(p, item) { let n = 0; for (const s of p.inv) if (s && s.id === item) n += s.n; return n; }
  findSlot(p, item) { return p.inv.findIndex((s) => s && s.id === item); }
  sendInv(p) { this.emit({ t: 'inv', id: p.id, inv: p.inv, armor: p.armor }); }

  spawnDrop(item, n, x, y, z, vx = 0, vy = 2, vz = 0, from = null) {
    const d = { id: nextId++, item, n, x, y, z, vx, vy, vz, from, age: 0 };
    this.drops.set(d.id, d);
    this.emit({ t: 'drop+', d });
  }
  dropSlot(p, slot) {
    const s = p.inv[slot];
    if (!s || !p.alive || this.phase !== 'play') return;
    const fx = -Math.sin(p.yaw) * Math.cos(p.pitch), fz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    this.spawnDrop(s.id, s.n, p.pos.x + fx * 0.4, p.pos.y + 1.3, p.pos.z + fz * 0.4, fx * 5, 2 + Math.sin(p.pitch) * 4, fz * 5, p.id);
    p.inv[slot] = null;
    this.sendInv(p);
  }

  // ---- blocks -----------------------------------------------------------------------------------------------------
  place(p, x, y, z, slot) {
    const s = p.inv[slot], def = s && ITEMS[s.id];
    const ok = this.phase === 'play' && p.alive && def && def.kind === 'block' && this.world.inside(x, y, z) && y < WORLD.H - 2
      && !this.world.get(x, y, z) && Math.hypot(x + 0.5 - p.pos.x, y + 0.5 - p.pos.y - 1.5, z + 0.5 - p.pos.z) < RULES.reach + 2
      && !this.blocked(x, y, z, p);
    if (!ok) { if (!p.bot) { this.emit({ t: 'blk', x, y, z, b: this.world.get(x, y, z) }, p.id); this.sendInv(p); } return false; }
    this.world.set(x, y, z, def.block);
    this.emit({ t: 'blk', x, y, z, b: def.block, by: p.id });
    this.take(p, slot, 1);
    return true;
  }
  /** Would a block here sit inside another player? */
  blocked(x, y, z, self) {
    for (const o of this.players.values()) {
      if (!o.alive || o === self) continue;
      if (o.pos.x + 0.3 > x && o.pos.x - 0.3 < x + 1 && o.pos.z + 0.3 > z && o.pos.z - 0.3 < z + 1 && o.pos.y + 1.8 > y && o.pos.y < y + 1) return true;
    }
    return false;
  }
  breakBlock(p, x, y, z) {
    const id = this.world.get(x, y, z);
    const ok = this.phase === 'play' && p.alive && id && BLOCKS[id].hard > 0 && this.t - p.breakAt > 0.1
      && Math.hypot(x + 0.5 - p.pos.x, y + 0.5 - p.pos.y - 1.5, z + 0.5 - p.pos.z) < RULES.reach + 2;
    if (!ok) { if (!p.bot) this.emit({ t: 'blk', x, y, z, b: id }, p.id); return false; }
    p.breakAt = this.t;
    this.world.set(x, y, z, 0);
    this.emit({ t: 'blk', x, y, z, b: 0, by: p.id, was: id });
    if (BLOCKS[id].item) this.give(p, BLOCKS[id].item, 1);
    return true;
  }

  openChest(p, x, y, z) {
    if (this.phase !== 'play' || !p.alive || this.world.get(x, y, z) !== B.CHEST) return false;
    if (Math.hypot(x + 0.5 - p.pos.x, y + 0.5 - p.pos.y - 1, z + 0.5 - p.pos.z) > RULES.reach + 2) return false;
    this.world.set(x, y, z, B.CHEST_OPEN);
    const c = this.world.chests.find((k) => k.x === x && k.y === y && k.z === z);
    if (c) c.open = true;
    this.emit({ t: 'blk', x, y, z, b: B.CHEST_OPEN, by: p.id, chest: true });
    const rare = !!(c && c.rare);
    for (let i = 0; i < (rare ? RULES.airItems : RULES.chestItems); i++) {
      const [item, n] = pickWeighted(rare ? GEN_LOOT : CHEST_LOOT), a = Math.random() * 6.28;
      this.spawnDrop(item, n, x + 0.5, y + 1.2, z + 0.5, Math.cos(a) * 1.8, 4.2, Math.sin(a) * 1.8);
    }
    return true;
  }

  // ---- fighting ---------------------------------------------------------------------------------------------------
  melee(p, v, o = {}) {
    if (this.phase !== 'play' || !p.alive || this.t - p.hitAt < RULES.hitCooldown) return;
    p.hitAt = this.t;
    const held = p.inv[p.slot], def = held && ITEMS[held.id];
    const w = def && (def.kind === 'melee' || def.kind === 'tool') ? def : FIST;
    // the attack bar: a swing right after the previous one is weak
    const charge = p.bot ? 1 : clamp((this.t - (p.swingAt ?? -9)) / (w.swing || RULES.swingTime), 0, 1);
    p.swingAt = this.t;
    this.emit({ t: 'swing', id: p.id });
    if (!v || !v.alive || v === p) return;
    const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z, dy = v.pos.y - p.pos.y;
    if (Math.hypot(dx, dz) > (w.reach || RULES.meleeReach) + 1.4 || Math.abs(dy) > 4) return;
    const d = Math.hypot(dx, dz) || 1;
    const k = RULES.kbH * w.kb * (o.sprint ? RULES.sprintKb : 1) * (0.5 + 0.5 * charge);
    this.damage(v, w.dmg * (CLASSES[p.cls].melee || 1) * (p.bot ? BOT.damage : 1) * (o.crit && charge > 0.9 ? RULES.crit : 1) * (0.25 + 0.75 * charge) * (p.fx.power > this.t ? 1.4 : 1), p, 'melee', [dx / d * k, RULES.kbV, dz / d * k], false, !!o.crit && charge > 0.9);
  }

  damage(v, amount, by, src, kb, raw = false, crit = false) {
    if (!v.alive || this.phase !== 'play') return;
    // just hit: safe for a moment, like the red flash in 1.8
    if (!raw) { if (v.hurtUntil > this.t) return; v.hurtUntil = this.t + RULES.hurtTime; }
    if (!raw) amount *= 1 - v.armor;
    // a raised sword stops part of a hit, an arrow or a rock
    if (v.fx.shield > this.t && !raw) { amount *= 0.3; kb = null; }
    const blocked = !!(v.flags & 4) && (src === 'melee' || src === 'arrow' || src === 'rock');
    if (blocked) { amount *= RULES.blockCut; if (kb) kb = [kb[0] * 0.5, kb[1] * 0.7, kb[2] * 0.5]; }
    v.hp = Math.max(0, v.hp - amount);
    v.hurtAt = this.t; v.regenAt = this.t + RULES.regenAfter;
    if (by) { v.lastBy = by.id; v.lastByAt = this.t; }
    if (kb) {
      const m = CLASSES[v.cls].kbTaken || 1;
      kb = [kb[0] * m, kb[1] * (0.5 + m * 0.5), kb[2] * m];
      if (v.bot) { v.vel.x = kb[0]; v.vel.y = kb[1]; v.vel.z = kb[2]; }
    }
    this.emit({ t: 'hp', id: v.id, hp: v.hp, by: by ? by.id : null, src, kb, blocked, crit });
    if (v.hp <= 0) this.kill(v, by || this.credit(v), src);
  }
  heal(p, amount) {
    p.hp = Math.min(p.maxHp, p.hp + amount * (CLASSES[p.cls].heal || 1));
    this.emit({ t: 'hp', id: p.id, hp: p.hp, src: 'heal' });
  }
  /** Who gets the kill when someone falls: the last player that hit them in the past 10 seconds. */
  credit(p) { return p.lastBy && this.t - p.lastByAt < 10 ? this.players.get(p.lastBy) || null : null; }

  kill(p, by, cause) {
    if (!p.alive) return;
    // the charm "Tweede kans" saves you once, but not from the void
    const charm = cause !== 'void' && cause !== 'weg' ? this.findSlot(p, 'totem') : -1;
    if (charm >= 0) {
      p.inv[charm] = null; p.hp = 8; p.hurtUntil = this.t + 1.5; p.regenAt = this.t + RULES.regenAfter;
      this.sendInv(p);
      this.emit({ t: 'hp', id: p.id, hp: p.hp, src: 'heal' });
      this.emit({ t: 'totem', id: p.id });
      return;
    }
    p.alive = false; p.hp = 0;
    if (cause !== 'void' && cause !== 'weg') {
      for (const s of p.inv) if (s) this.spawnDrop(s.id, s.n, p.pos.x, p.pos.y + 0.8, p.pos.z, (Math.random() - 0.5) * 4, 3 + Math.random() * 2, (Math.random() - 0.5) * 4);
    }
    p.inv = Array(9).fill(null); p.armor = 0;
    this.sendInv(p);
    if (by && by !== p) { by.kills++; if (by.alive) this.heal(by, RULES.killHeal); }
    this.order.push(p.id);
    this.emit({ t: 'die', id: p.id, by: by && by !== p ? by.id : null, cause });
    this.checkEnd();
  }

  use(p, m) {
    if (this.phase !== 'play' || !p.alive) return;
    const slot = clamp(m.slot | 0, 0, 8), s = p.inv[slot], def = s && ITEMS[s.id];
    if (!def) return;
    const eye = m.pos && Math.hypot(m.pos[0] - p.pos.x, m.pos[1] - p.pos.y, m.pos[2] - p.pos.z) < 4 ? m.pos : [p.pos.x, p.pos.y + PHYS.eye, p.pos.z];
    const dir = m.dir && m.dir.length === 3 ? m.dir : [-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch)];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const shoot = (kind, speed, extra = {}) => {
      const pr = { id: nextId++, kind, owner: p.id, x: eye[0] + dir[0] / len * 0.3, y: eye[1] - 0.1 + dir[1] / len * 0.3, z: eye[2] + dir[2] / len * 0.3,
        vx: dir[0] / len * speed, vy: dir[1] / len * speed, vz: dir[2] / len * speed, age: 0, ...extra };
      this.projs.set(pr.id, pr);
      this.emit({ t: 'proj+', p: pr });
    };
    if (def.kind === 'food' || def.kind === 'potion') {
      if (this.t - p.useAt < 0.5) return;
      p.useAt = this.t;
      if (def.heal) { if (p.hp >= p.maxHp) return; this.heal(p, def.heal); }
      if (def.effect) { const time = def.time * (CLASSES[p.cls].heal || 1); p.fx[def.effect] = this.t + time; this.emit({ t: 'fx', id: p.id, effect: def.effect, time }); }
      this.emit({ t: 'used', id: p.id, item: s.id });
      this.take(p, slot);
    } else if (def.kind === 'armor') {
      if (def.armor <= p.armor) return;
      p.armor = def.armor;
      this.emit({ t: 'used', id: p.id, item: s.id });
      this.take(p, slot);
    } else if (def.kind === 'throw') {
      if (this.t - p.useAt < 0.3) return;
      p.useAt = this.t;
      shoot(s.id, def.speed, { fuse: def.fuse });
      this.take(p, slot);
    } else if (def.kind === 'bow') {
      const a = this.findSlot(p, 'arrow');
      if (a < 0 || this.t - p.useAt < 0.25) return;
      p.useAt = this.t;
      const charge = clamp(+m.charge || 0, 0.15, 1);
      shoot('arrow', 13 + 27 * charge, { dmg: (2 + 7 * charge) * (CLASSES[p.cls].ranged || 1) * (p.bot ? BOT.damage : 1) });
      this.take(p, a);
    }
  }

  stepProjectile(pr, dt) {
    const ox = pr.x, oy = pr.y, oz = pr.z;
    const hit = stepProj(this.world, pr, dt);
    if (pr.kind === 'bomb' && pr.age >= pr.fuse) return this.explode(pr);
    if (pr.stuck) return;
    let victim = null;
    for (const v of this.players.values()) {
      if (!v.alive || (v.id === pr.owner && pr.age < 0.35)) continue;
      if (segHitsBox(ox, oy, oz, pr.x, pr.y, pr.z, v.pos)) { victim = v; break; }
    }
    const owner = this.players.get(pr.owner) || null;
    if (victim) {
      const sp = Math.hypot(pr.vx, pr.vz) || 1;
      if (pr.kind === 'arrow') this.damage(victim, pr.dmg, owner, 'arrow', [pr.vx / sp * 5, 3.6, pr.vz / sp * 5]);
      else if (pr.kind === 'rock') this.damage(victim, ITEMS.rock.dmg, owner, 'rock', [pr.vx / sp * 7.5 * ITEMS.rock.kb, 4.6, pr.vz / sp * 7.5 * ITEMS.rock.kb]);
      else if (pr.kind === 'bomb') return this.explode(pr);
      else if (pr.kind === 'fire') return this.explode(pr, true);
      else if (pr.kind === 'hook') this.hookPull(victim, owner);
      else if (pr.kind === 'wind') return this.windBurst(pr);
      else if (pr.kind === 'warp') this.warp(owner, pr);
      return this.endProj(pr, victim.id);
    }
    if (hit) {
      if (pr.kind === 'bomb') { pr.stuck = true; pr.vx = pr.vy = pr.vz = 0; this.emit({ t: 'proj=', id: pr.id, x: pr.x, y: pr.y, z: pr.z }); return; }
      if (pr.kind === 'fire') return this.explode(pr, true);
      if (pr.kind === 'wind') return this.windBurst(pr);
      if (pr.kind === 'warp') this.warp(owner, pr, hit);
      return this.endProj(pr, null);
    }
    if (pr.y < RULES.voidY - 20 || pr.age > 8) this.endProj(pr, null);
  }
  endProj(pr, hitId) {
    this.projs.delete(pr.id);
    this.emit({ t: 'proj-', id: pr.id, x: pr.x, y: pr.y, z: pr.z, hit: hitId });
  }
  /** Grappling hook: yank the player it hit toward the one who threw it. */
  hookPull(victim, owner) {
    if (!owner || !owner.alive || !victim.alive || victim === owner) return;
    const dx = owner.pos.x - victim.pos.x, dz = owner.pos.z - victim.pos.z, d = Math.hypot(dx, dz) || 1;
    // in the air a player slows down by itself, so the start speed is chosen to land about 1.5 blocks in front of you
    const sp = clamp((d - 1.5) / 0.265, 3, 28);
    const vel = [dx / d * sp, 8 + clamp((owner.pos.y - victim.pos.y) * 1.2, 0, 6), dz / d * sp];
    victim.lastBy = owner.id; victim.lastByAt = this.t;
    if (victim.bot) victim.vel = { x: vel[0], y: vel[1], z: vel[2] };
    this.emit({ t: 'pull', id: victim.id, vel, by: owner.id });
  }
  /** Wind charge: a gust that throws everyone close to the impact away and up. The thrower goes mostly up. */
  windBurst(pr) {
    const R = 2.8, owner = this.players.get(pr.owner) || null;
    this.projs.delete(pr.id);
    this.emit({ t: 'wind', id: pr.id, x: pr.x, y: pr.y, z: pr.z });
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      const dx = v.pos.x - pr.x, dy = v.pos.y + 0.9 - pr.y, dz = v.pos.z - pr.z, d = Math.hypot(dx, dy, dz);
      if (d > R) continue;
      const f = 1 - (d / R) * 0.55, h = Math.hypot(dx, dz) || 1;
      const self = v.id === pr.owner;
      // others fly the way the charge was flying, plus a bit away from the impact, so a hit at someone's feet
      // never throws them toward you
      const ph = Math.hypot(pr.vx, pr.vz) || 1;
      let px = pr.vx / ph + dx / h * 0.6, pz = pr.vz / ph + dz / h * 0.6;
      const pn = Math.hypot(px, pz) || 1; px /= pn; pz /= pn;
      const vel = self ? [dx / h * 4 * f, 6 + 9 * f, dz / h * 4 * f] : [px * 17 * f, 7 + 4 * f, pz * 17 * f];
      if (!self && owner) { v.lastBy = owner.id; v.lastByAt = this.t; }
      if (v.bot) v.vel = { x: vel[0], y: vel[1], z: vel[2] };
      this.emit({ t: 'pull', id: v.id, vel, wind: true });
    }
  }
  /** Fire a projectile from a player. */
  launch(p, kind, dir, speed, extra = {}) {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const pr = { id: nextId++, kind, owner: p.id, x: p.pos.x + dir[0] / len * 0.3, y: p.pos.y + PHYS.eye - 0.1, z: p.pos.z + dir[2] / len * 0.3,
      vx: dir[0] / len * speed, vy: dir[1] / len * speed, vz: dir[2] / len * speed, age: 0, ...extra };
    this.projs.set(pr.id, pr);
    this.emit({ t: 'proj+', p: pr });
  }
  /** The special move of a class. */
  ability(p, m = {}) {
    if (this.phase !== 'play' || !p.alive || this.t < (p.abAt || 0)) return false;
    const ab = ABILITIES[p.cls];
    p.abAt = this.t + ab.cd;
    const dir = m.dir && m.dir.length === 3 ? m.dir : [-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch)];
    const h = Math.hypot(dir[0], dir[2]) || 1, fx = dir[0] / h, fz = dir[2] / h;
    let vel = null;
    if (p.cls === 'bouwer') {
      const cx = Math.floor(p.pos.x + fx * 2.5), cz = Math.floor(p.pos.z + fz * 2.5), cy = Math.floor(p.pos.y + 0.01);
      const side = Math.abs(fx) > Math.abs(fz) ? [0, 1] : [1, 0];
      for (let a = -1; a <= 1; a++) for (let k = 0; k < 3; k++) {
        const x = cx + side[0] * a, y = cy + k, z = cz + side[1] * a;
        if (this.world.inside(x, y, z) && !this.world.get(x, y, z) && !this.blocked(x, y, z, null)) { this.world.set(x, y, z, B.WOOL); this.emit({ t: 'blk', x, y, z, b: B.WOOL, by: p.id }); }
      }
    } else if (p.cls === 'krijger') { vel = [fx * 13, 4.6, fz * 13]; p.fx.power = this.t + 3; this.emit({ t: 'fx', id: p.id, effect: 'power', time: 3 }); }
    else if (p.cls === 'schutter') { for (const a of [-0.11, 0, 0.11]) { const c = Math.cos(a), s = Math.sin(a); this.launch(p, 'arrow', [dir[0] * c - dir[2] * s, dir[1] + 0.04, dir[0] * s + dir[2] * c], 36, { dmg: 6 * (CLASSES[p.cls].ranged || 1) * (p.bot ? BOT.damage : 1) }); } }
    else if (p.cls === 'verkenner') vel = [fx * 9.5, 12.5, fz * 9.5];
    else if (p.cls === 'tank') { p.fx.shield = this.t + 4; this.emit({ t: 'fx', id: p.id, effect: 'shield', time: 4 }); }
    else if (p.cls === 'alchemist') { this.heal(p, 6); p.fx.speed = this.t + 5; this.emit({ t: 'fx', id: p.id, effect: 'speed', time: 5 }); }
    if (vel && p.bot) p.vel = { x: vel[0], y: vel[1], z: vel[2] };
    this.emit({ t: 'ab', id: p.id, cls: p.cls, cd: ab.cd, vel });
    return true;
  }
  warp(owner, pr, hit) {
    if (!owner || !owner.alive) return;
    let x = pr.x, y = pr.y, z = pr.z;
    if (hit) { x += hit.nx * 0.45; z += hit.nz * 0.45; if (hit.ny > 0) y = hit.y + 1; else if (hit.ny < 0) y = hit.y - 1.85; else y = Math.floor(y); }
    for (let k = 0; k < 4 && this.world.boxHits(x, y, z, PHYS.width, PHYS.height); k++) y += 1;
    owner.pos.x = x; owner.pos.y = y; owner.pos.z = z;
    if (owner.bot) owner.vel = { x: 0, y: 0, z: 0 };
    this.emit({ t: 'tp', id: owner.id, x, y, z });
  }
  /** small = fireball: a weaker burst that only breaks soft blocks. */
  explode(pr, small = false) {
    const r = small ? 1.5 : 2.3, cells = [];
    const cx = Math.floor(pr.x), cy = Math.floor(pr.y), cz = Math.floor(pr.z);
    for (let x = cx - 3; x <= cx + 3; x++) for (let y = cy - 3; y <= cy + 3; y++) for (let z = cz - 3; z <= cz + 3; z++) {
      const id = this.world.get(x, y, z);
      if (!id || BLOCKS[id].hard === 0 || (small && BLOCKS[id].hard > 1)) continue;
      if (Math.hypot(x + 0.5 - pr.x, y + 0.5 - pr.y, z + 0.5 - pr.z) > r + (BLOCKS[id].hard > 2 ? -1 : 0)) continue;
      this.world.set(x, y, z, 0); cells.push([x, y, z]);
    }
    const owner = this.players.get(pr.owner) || null, R = small ? 3 : ITEMS.bomb.blast + 1;
    this.projs.delete(pr.id);
    this.emit({ t: 'boom', id: pr.id, x: pr.x, y: pr.y, z: pr.z, cells, small });
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      const dx = v.pos.x - pr.x, dy = v.pos.y + 0.9 - pr.y, dz = v.pos.z - pr.z, d = Math.hypot(dx, dy, dz);
      if (d > R) continue;
      const f = 1 - d / R, h = Math.hypot(dx, dz) || 1, k = small ? 0.6 : 1;
      this.damage(v, (small ? 2 + 5 * f : 3 + 11 * f), owner, 'bom', [dx / h * 11 * f * k, (4 + 6 * f) * k, dz / h * 11 * f * k]);
    }
  }
}
