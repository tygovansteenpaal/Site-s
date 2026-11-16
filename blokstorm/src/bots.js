// BLOKSTORM - computer players. They wait for blocks, bridge to the middle, grab loot and fight.
import { PHYS, RULES, WORLD, ITEMS, CLASSES, BOT } from './config.js';
import { moveBody } from './world.js';
import { zoneRadius, distToMiddle } from './shared.js';
import { angleLerp } from './util.js';

const BLOCK_ITEMS = ['planks', 'wool', 'stone', 'brick', 'bounce'];

function bestMelee(sim, p) {
  let best = -1, dmg = 1;
  p.inv.forEach((s, i) => { const d = s && ITEMS[s.id]; if (d && (d.kind === 'melee' || d.kind === 'tool') && d.dmg > dmg) { dmg = d.dmg; best = i; } });
  return best;
}
function blockSlot(p) { return p.inv.findIndex((s) => s && BLOCK_ITEMS.includes(s.id)); }
function blockCount(p) { let n = 0; for (const s of p.inv) if (s && BLOCK_ITEMS.includes(s.id)) n += s.n; return n; }

export function updateBot(sim, p, dt) {
  const ai = p.ai, world = sim.world, cls = CLASSES[p.cls];
  ai.cd -= dt; ai.place -= dt; ai.use -= dt; ai.shoot -= dt; ai.side -= dt; ai.jumpCd -= dt;

  // use what helps right away
  if (ai.use <= 0) {
    ai.use = 0.7;
    for (let i = 0; i < 9; i++) {
      const s = p.inv[i], d = s && ITEMS[s.id];
      if (!d) continue;
      if (d.kind === 'armor' && d.armor > p.armor) { sim.use(p, { slot: i }); break; }
      if (d.heal && p.hp <= p.maxHp - Math.min(d.heal, 7)) { sim.use(p, { slot: i }); break; }
      if (d.effect && !p.fx[d.effect] && sim.t > 20) { sim.use(p, { slot: i }); break; }
    }
  }

  // nearest enemy
  let enemy = null, eDist = 1e9;
  for (const o of sim.players.values()) {
    if (!o.alive || o === p) continue;
    const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
    if (d < eDist && Math.abs(o.pos.y - p.pos.y) < 5) { eDist = d; enemy = o; }
  }

  // where to go
  const zone = zoneRadius(sim.t), mid = distToMiddle(p.pos.x, p.pos.z);
  let gx = WORLD.CX + 0.5, gz = WORLD.CZ + 0.5, go = true, fight = false;
  if (enemy && eDist < BOT.see) { gx = enemy.pos.x; gz = enemy.pos.z; fight = true; }
  else {
    let drop = null, dd = 9;
    for (const d of sim.drops.values()) { const k = Math.hypot(d.x - p.pos.x, d.z - p.pos.z); if (k < dd && Math.abs(d.y - p.pos.y) < 3) { dd = k; drop = d; } }
    if (drop) { gx = drop.x; gz = drop.z; }
    else if (mid < 4) { if (ai.side <= 0) { ai.side = 2 + Math.random() * 2; ai.wx = WORLD.CX + 0.5 + (Math.random() - 0.5) * 3; ai.wz = WORLD.CZ + 0.5 + (Math.random() - 0.5) * 3; } gx = ai.wx; gz = ai.wz; }
    else {
      const ready = sim.t >= ai.wait || blockCount(p) >= 14;
      let chest = null, cd = 15;
      if (ready) for (const c of world.chests) { const k = Math.hypot(c.x + 0.5 - p.pos.x, c.z + 0.5 - p.pos.z); if (!c.open && k < cd) { cd = k; chest = c; } }
      if (chest) { gx = chest.x + 0.5; gz = chest.z + 0.5; if (cd < 2.3) sim.openChest(p, chest.x, chest.y, chest.z); }
      else if (!ready && mid < zone - 6) go = false;
    }
  }
  if (mid > zone - 4) { gx = WORLD.CX + 0.5; gz = WORLD.CZ + 0.5; go = true; }

  let dx = gx - p.pos.x, dz = gz - p.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  dx /= dist; dz /= dist;
  // circle around the enemy a little while fighting
  if (fight && eDist < 3.4) {
    if (ai.side <= 0) { ai.side = 0.8 + Math.random() * 1.2; ai.strafe = Math.random() < 0.4 ? 0 : Math.random() < 0.5 ? -1 : 1; }
    const back = eDist < 1.7 ? -0.7 : 0.25;
    // the wander code also uses ai.side, so the strafe direction may not be set yet
    const st = ai.strafe || 0, sx = -dz * st, sz = dx * st;
    dx = dx * back + sx * 0.8; dz = dz * back + sz * 0.8;
    const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n;
  }

  const ground = world.boxHits(p.pos.x, p.pos.y - 0.05, p.pos.z, PHYS.width, PHYS.height);
  let speed = go && dist > 0.5 ? PHYS.walk * BOT.speed * (cls.speed || 1) * (p.fx.speed ? 1.35 : 1) : 0;
  let sneak = true;

  if (speed > 0 && ground) {
    const feet = Math.round(p.pos.y);
    const ax = Math.floor(p.pos.x + dx * 0.75), az = Math.floor(p.pos.z + dz * 0.75);
    let floor = -1;
    for (let k = 1; k <= 4; k++) if (world.solid(ax, feet - k, az)) { floor = k; break; }
    if (floor === 1) sneak = false;
    else if (floor > 1 && !(fight && floor > 2)) sneak = false;      // a safe step down
    else {
      // nothing there: build a bridge block, or wait for more blocks
      const slot = blockSlot(p);
      if (slot >= 0 && ai.place <= 0) { if (sim.place(p, ax, feet - 1, az, slot)) ai.place = BOT.bridgeEvery; }
      if (!world.solid(ax, feet - 1, az)) speed = 0;
    }
    // a wall in the way: jump onto it
    if (speed > 0 && world.solid(ax, feet, az) && ai.jumpCd <= 0) {
      if (!world.solid(ax, feet + 1, az) && !world.solid(ax, feet + 2, az)) { p.vel.y = PHYS.jump; ai.jumpCd = 0.5; }
      else { const s = bestMelee(sim, p); if (s >= 0) p.slot = s; sim.breakBlock(p, ax, feet + 1, az) || sim.breakBlock(p, ax, feet, az); ai.jumpCd = 0.6; }
    }
  }

  // steer: on the ground the bot decides, in the air it mostly keeps flying (so knockback works)
  const acc = ground ? PHYS.accelGround : 1.5;
  const k = Math.min(1, acc * dt);
  p.vel.x += (dx * speed - p.vel.x) * k; p.vel.z += (dz * speed - p.vel.z) * k;
  p.vel.y = Math.max(-PHYS.terminal, p.vel.y - PHYS.gravity * dt);
  // never let one bad number freeze a bot for the rest of the round
  if (!Number.isFinite(p.vel.x)) p.vel.x = 0; if (!Number.isFinite(p.vel.z)) p.vel.z = 0; if (!Number.isFinite(p.vel.y)) p.vel.y = 0;
  moveBody(world, p.pos, p.vel, dt, PHYS.width, PHYS.height, sneak && ground);

  // face the enemy or the way it walks
  const face = fight ? Math.atan2(-(enemy.pos.x - p.pos.x), -(enemy.pos.z - p.pos.z)) : Math.atan2(-dx, -dz);
  p.yaw = angleLerp(p.yaw, face, Math.min(1, dt * 10));
  p.pitch = fight ? Math.atan2(enemy.pos.y - p.pos.y, Math.max(1, eDist)) * 0.8 : 0;
  p.flags = (ground ? 2 : 0);

  if (fight) {
    const melee = bestMelee(sim, p);
    if (eDist < RULES.meleeReach - 0.3) {
      if (melee >= 0) p.slot = melee;
      if (ai.cd <= 0) {
        ai.cd = BOT.attackEvery[0] + Math.random() * (BOT.attackEvery[1] - BOT.attackEvery[0]);
        if (Math.random() < BOT.whiff) sim.emit({ t: 'swing', id: p.id }); else sim.melee(p, enemy);
      }
    } else if (ai.shoot <= 0 && eDist > 4) {
      const ex = enemy.pos.x - p.pos.x, ey = enemy.pos.y + 1.1 - (p.pos.y + PHYS.eye), ez = enemy.pos.z - p.pos.z;
      const clear = !world.raycast(p.pos.x, p.pos.y + PHYS.eye, p.pos.z, ex / eDist, ey / eDist, ez / eDist, eDist - 0.5);
      const bow = sim.findSlot(p, 'bow'), rock = sim.findSlot(p, 'rock');
      const miss = () => (Math.random() - 0.5) * BOT.aimMiss;
      const next = () => BOT.shootEvery[0] + Math.random() * (BOT.shootEvery[1] - BOT.shootEvery[0]);
      if (clear && bow >= 0 && sim.count(p, 'arrow') > 0) {
        p.slot = bow; ai.shoot = next();
        sim.use(p, { slot: bow, charge: 0.85, dir: [ex / eDist + miss(), ey / eDist + eDist * 0.012 + miss() * 0.5, ez / eDist + miss()] });
      } else if (clear && rock >= 0 && eDist < 12) {
        p.slot = rock; ai.shoot = next() * 0.7;
        sim.use(p, { slot: rock, dir: [ex / eDist + miss(), ey / eDist + eDist * 0.02 + miss() * 0.5, ez / eDist + miss()] });
      } else ai.shoot = 0.5;
    } else if (melee >= 0) p.slot = melee;
  } else if (speed > 0) { const b = blockSlot(p); if (b >= 0) p.slot = b; }

  if (p.pos.y < RULES.voidY) sim.kill(p, sim.credit(p), 'void');
}
