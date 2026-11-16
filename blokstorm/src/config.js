// BLOKSTORM - all tunable numbers, items, classes and loot tables live here.

export const APP_ID = 'blokstorm-v1';
export const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.mom',
  'wss://relay.nostr.net', 'wss://nostr.oxtr.dev'];

export const WORLD = { W: 112, H: 48, D: 112, CX: 56, CZ: 56, CHUNK: 16 };

export const RULES = {
  maxPlayers: 8,
  spawnRadius: 34,        // distance of the spawn islands from the middle
  spawnY: 22,             // feet height on a spawn island
  countdown: 5,           // seconds frozen on the island before the round starts
  startBlocks: 5,         // planks every class gets on top of its own kit
  dripEvery: 4,           // seconds between random items
  eatTime: 0.8,           // seconds you hold the button to eat or drink
  regenAfter: 6,          // seconds without damage before hit points come back
  regenEvery: 3,          // seconds per hit point that comes back
  fallSafe: 3.5,
  chestItems: 3,          // items that pop out of a chest
  blockCut: 0.5,          // share of damage that still gets through while you block with a sword          // blocks you can fall without damage
  genEvery: 7,            // seconds between generator drops
  genMaxDrops: 6,         // loot lying on the generator at most
  zoneDelay: 60,          // seconds before the circle starts closing
  zoneShrink: 110,        // seconds the circle takes to close
  zoneStart: 58,          // radius at the start
  zoneEnd: 3,             // radius at the end
  zoneDps: 1.5,           // damage per second outside the circle, grows over time
  voidY: -10,
  endScreen: 9,
  reach: 4.6,
  // fighting like the classic 1.8 feel: click as fast as you want, but a player who was just hit cannot be
  // hit again for half a second. Sprinting hits push further, hits while falling are critical.
  meleeReach: 3.0,
  hitCooldown: 0.05,
  staminaDrain: 16,       // stamina (out of 100) that sprinting costs per second
  staminaGain: 22,        // stamina that comes back per second when you do not sprint
  staminaJump: 5,         // extra cost of a jump while sprinting
  staminaBack: 25,        // after running empty you can sprint again from this much
  swingTime: 0.5,         // seconds the attack bar needs to fill; a hit on an empty bar is weak
  killHeal: 4,            // hit points you get back for a kill
  airEvery: 40,           // seconds between air drops
  airItems: 4,            // items in an air drop (from the generator loot)
  hurtTime: 0.5,          // seconds a player is safe after taking a hit
  kbH: 7.6,               // knockback sideways (blocks per second)
  kbV: 6.6,               // knockback upward
  sprintKb: 1.65,         // extra push when the attacker sprints
  crit: 1.5,              // damage multiplier for a hit while falling
};

// How good the computer players are. Lower damage and more misses make them easier.
export const BOT = {
  damage: 0.55,            // their hits and arrows do this share of normal damage
  whiff: 0.35,             // chance a sword swing misses completely
  attackEvery: [0.9, 1.6], // seconds between swings
  shootEvery: [2.6, 4.8],  // seconds between arrows or rocks
  aimMiss: 0.36,           // how far off their shots can be
  bridgeEvery: 0.5,        // seconds per bridge block
  wait: [6, 18],          // seconds they collect items before leaving their island
  speed: 0.8,              // walking speed compared to a player
  see: 9,                  // distance at which they notice an enemy
};

export const PHYS = {
  gravity: 27, jump: 8.3, walk: 3.7, sprint: 4.9, sneak: 1.3,
  width: 0.6, height: 1.8, eye: 1.62, eyeSneak: 1.42,
  accelGround: 11, accelAir: 3.2, terminal: 54,
};

// ---- blocks -------------------------------------------------------------------------------------------------------
// tiles are indexes into the block atlas (see textures.js). hard = seconds to break by hand; 0 = cannot break.
export const B = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, PLANKS: 4, WOOL: 5, CORE: 6, GEN: 7, BRICK: 8, LOG: 9, LEAVES: 10, HARD: 11, CHEST: 12, CHEST_OPEN: 13, BOUNCE: 14, GOLD: 15, PILLAR: 16 };
export const BLOCKS = [
  null,
  { name: 'gras', top: 0, side: 1, bottom: 2, hard: 0.6 },
  { name: 'aarde', top: 2, side: 2, bottom: 2, hard: 0.5 },
  { name: 'steen', top: 3, side: 3, bottom: 3, hard: 1.5, item: 'stone' },
  { name: 'planken', top: 4, side: 4, bottom: 4, hard: 0.7, item: 'planks' },
  { name: 'wol', top: 5, side: 5, bottom: 5, hard: 0.3, item: 'wool' },
  { name: 'kernsteen', top: 6, side: 7, bottom: 6, hard: 0 },
  { name: 'generator', top: 8, side: 9, bottom: 6, hard: 0 },
  { name: 'baksteen', top: 10, side: 10, bottom: 10, hard: 2.2, item: 'brick' },
  { name: 'stam', top: 11, side: 12, bottom: 11, hard: 0.9 },
  { name: 'blad', top: 13, side: 13, bottom: 13, hard: 0.2 },
  { name: 'donkersteen', top: 14, side: 14, bottom: 14, hard: 4 },
  { name: 'kist', top: 15, side: 16, bottom: 15, hard: 0 },
  { name: 'open kist', top: 17, side: 16, bottom: 15, hard: 0 },
  { name: 'springblok', top: 18, side: 18, bottom: 18, hard: 0.4, item: 'bounce' },
  { name: 'goud', top: 19, side: 19, bottom: 19, hard: 0 },
  { name: 'obsidiaan', top: 14, side: 14, bottom: 14, hard: 0 },
];

// ---- items --------------------------------------------------------------------------------------------------------
// kind: block | melee | bow | ammo | throw | food | potion | armor | tool
export const ITEMS = {
  planks: { name: 'Planken', kind: 'block', block: B.PLANKS, stack: 64 },
  wool: { name: 'Wol', kind: 'block', block: B.WOOL, stack: 64 },
  stone: { name: 'Steen', kind: 'block', block: B.STONE, stack: 64 },
  brick: { name: 'Baksteen', kind: 'block', block: B.BRICK, stack: 64 },
  bounce: { name: 'Springblok', kind: 'block', block: B.BOUNCE, stack: 16 },

  sword_wood: { name: 'Houten zwaard', kind: 'melee', dmg: 4, kb: 1 },
  sword_stone: { name: 'Stenen zwaard', kind: 'melee', dmg: 5, kb: 1 },
  sword_iron: { name: 'IJzeren zwaard', kind: 'melee', dmg: 6.5, kb: 1.05 },
  sword_crystal: { name: 'Kristalzwaard', kind: 'melee', dmg: 8, kb: 1.1 },
  spear: { name: 'Speer', kind: 'melee', dmg: 5, kb: 1.15, reach: 4.3 },             // hits from further away
  axe: { name: 'Strijdbijl', kind: 'melee', dmg: 9, kb: 1.3, swing: 0.95 },          // heavy: the bar fills slowly
  pickaxe: { name: 'Houweel', kind: 'tool', dmg: 3, kb: 1, mine: 4 },

  bow: { name: 'Boog', kind: 'bow' },
  arrow: { name: 'Pijl', kind: 'ammo', stack: 64 },
  rock: { name: 'Kei', kind: 'throw', stack: 16, dmg: 1, kb: 1.5, speed: 24 },
  bomb: { name: 'Bom', kind: 'throw', stack: 8, speed: 17, fuse: 1.7, blast: 3.2 },
  warp: { name: 'Warpbol', kind: 'throw', stack: 4, speed: 26 },
  fire: { name: 'Vuurbal', kind: 'throw', stack: 8, speed: 30 },                    // bursts on impact
  hook: { name: 'Grijphaak', kind: 'throw', stack: 4, speed: 34 },                  // pulls the player it hits toward you
  totem: { name: 'Tweede kans', kind: 'charm' },                                   // saves you once from dying

  apple: { name: 'Appel', kind: 'food', stack: 16, heal: 4 },
  apple_gold: { name: 'Gouden appel', kind: 'food', stack: 8, heal: 10 },
  potion_heal: { name: 'Geneesdrank', kind: 'potion', stack: 4, heal: 8 },
  potion_speed: { name: 'Sneldrank', kind: 'potion', stack: 4, effect: 'speed', time: 12 },
  potion_jump: { name: 'Springdrank', kind: 'potion', stack: 4, effect: 'jump', time: 12 },
  potion_slowfall: { name: 'Zweefdrank', kind: 'potion', stack: 4, effect: 'slowfall', time: 15 },
  wind: { name: 'Windlading', kind: 'throw', stack: 8, speed: 26 },              // blows everyone near the impact away, also yourself

  vest_leather: { name: 'Leren vest', kind: 'armor', armor: 0.15 },
  vest_iron: { name: 'IJzeren vest', kind: 'armor', armor: 0.3 },
  vest_crystal: { name: 'Kristalvest', kind: 'armor', armor: 0.45 },
};
export const ITEM_IDS = Object.keys(ITEMS);
export const FIST = { dmg: 1, kb: 1 };

// ---- loot ---------------------------------------------------------------------------------------------------------
// [item, amount, weight]. A higher weight means the item shows up more often.
// TODO(jij): dit is de plek om de balans van de game te bepalen. Meer blokken = sneller bruggen bouwen en eerder
// vechten. Meer wapens = gevechten op afstand vanaf je eigen eiland. Pas de gewichten aan en kijk wat leuker speelt.
export const DRIP_LOOT = [
  ['planks', 4, 30], ['wool', 4, 20], ['stone', 3, 10],
  ['rock', 3, 8], ['apple', 1, 7], ['arrow', 3, 5],
  ['sword_wood', 1, 6], ['bow', 1, 4], ['pickaxe', 1, 3], ['spear', 1, 3], ['bounce', 2, 2],
  ['vest_leather', 1, 2], ['sword_stone', 1, 2], ['potion_speed', 1, 1], ['wind', 1, 2], ['potion_slowfall', 1, 1], ['potion_jump', 1, 1], ['bomb', 1, 1],
];
// what a chest on one of the stepping islands can hold
export const CHEST_LOOT = [
  ['sword_stone', 1, 12], ['sword_iron', 1, 5], ['bow', 1, 8], ['arrow', 5, 10], ['pickaxe', 1, 6],
  ['apple', 2, 10], ['apple_gold', 1, 3], ['potion_heal', 1, 6], ['vest_leather', 1, 8], ['vest_iron', 1, 4],
  ['planks', 12, 10], ['brick', 6, 6], ['bomb', 1, 5], ['warp', 1, 3],
  ['spear', 1, 8], ['axe', 1, 5], ['hook', 1, 6], ['bounce', 4, 5], ['fire', 2, 4],
];
export const GEN_LOOT = [
  ['sword_iron', 1, 14], ['sword_crystal', 1, 5], ['vest_iron', 1, 10], ['vest_crystal', 1, 4],
  ['bow', 1, 7], ['arrow', 6, 12], ['apple_gold', 1, 8], ['potion_heal', 1, 12],
  ['bomb', 2, 10], ['warp', 1, 8], ['brick', 8, 9],
  ['axe', 1, 7], ['fire', 3, 9], ['hook', 2, 7], ['totem', 1, 4],
];

// ---- classes ------------------------------------------------------------------------------------------------------
// A class only decides what you start with (everyone also gets RULES.startBlocks planks). Everyone has the same speed, hit points and damage.
// The kits are meant to be worth about the same: change one and check it does not beat the others.
export const CLASSES = {
  bouwer: { name: 'Bouwer', line: 'Start met 15 extra planken.', kit: [['planks', 15]] },
  krijger: { name: 'Krijger', line: 'Start met een houten zwaard.', kit: [['sword_wood', 1]] },
  schutter: { name: 'Schutter', line: 'Start met een boog en 6 pijlen.', kit: [['bow', 1], ['arrow', 6]] },
  verkenner: { name: 'Verkenner', line: 'Start met een grijphaak: trekt een speler naar je toe.', kit: [['hook', 1]] },
  tank: { name: 'Tank', line: 'Start met een leren vest en een appel.', kit: [['vest_leather', 1], ['apple', 1]] },
  alchemist: { name: 'Alchemist', line: 'Start met een geneesdrank en een sneldrank.', kit: [['potion_heal', 1], ['potion_speed', 1]] },
  zwever: { name: 'Zwever', line: 'Start met 2 zweefdranken: 15 seconden langzaam vallen, geen valschade.', kit: [['potion_slowfall', 2]] },
  windloper: { name: 'Windloper', line: 'Start met 2 windladingen: blaas anderen weg of lanceer jezelf.', kit: [['wind', 2]] },
};
export const CLASS_IDS = Object.keys(CLASSES);

// One special move per class, on a cooldown (seconds).
export const ABILITIES = {
  bouwer: { name: 'Muur', cd: 22, line: 'Zet direct een wollen muur van 3 bij 3 voor je neer.' },
  krijger: { name: 'Uitval', cd: 12, line: 'Schiet naar voren. Je volgende klappen doen 3 seconden 40% meer schade.' },
  schutter: { name: 'Salvo', cd: 16, line: 'Schiet drie pijlen tegelijk, zonder pijlen te gebruiken.' },
  verkenner: { name: 'Sprong', cd: 13, line: 'Maak een enorme sprong vooruit en land zonder valschade.' },
  tank: { name: 'Schild', cd: 24, line: 'Vier seconden lang 70% minder schade en geen terugslag.' },
  alchemist: { name: 'Elixer', cd: 24, line: 'Geneest je meteen en maakt je 5 seconden sneller.' },
};

// Maps the host can pick. ring = distance of the spawn islands, mids = rings of stepping islands
// [count, distance, size, chests on every n-th island].
export const MAPS = {
  torens: { name: 'Torens', line: 'Dunne torens dicht bij elkaar, de generator op een gouden platform in het midden. Klein en snel.', ring: 11, middle: 2, mids: [], towers: true, zone: [15, 40] },
  klassiek: { name: 'Klassiek', line: 'Acht tussen-eilanden, alles in balans.', ring: 34, middle: 8, mids: [[8, 21, 2.5, 1]] },
  archipel: { name: 'Archipel', line: 'Veel kleine eilandjes in twee ringen.', ring: 38, middle: 6, mids: [[6, 14, 1.8, 2], [10, 26, 2.2, 2]] },
  reuzen: { name: 'Reuzen', line: 'Vier grote eilanden met dubbele kisten.', ring: 36, middle: 10, mids: [[4, 21, 5.5, 1]], twin: true },
  mini: { name: 'Mini', line: 'Klein en snel: direct naar het midden.', ring: 22, middle: 7, mids: [], centerChests: 2 },
};
export const MAP_IDS = Object.keys(MAPS);

// Coins: what a round pays and what the special looks cost. Index = option number in LOOK.
export const PAY = { play: 10, kill: 15, win: 60, topHalf: 15 };
export const PRICES = {
  hairStyle: [0, 0, 0, 150],
  cape: [0, 0, 100, 150, 200, 400, 600, 900, 1200],
  hat: [0, 100, 800, 300, 100, 500, 1000],
};
export const levelOf = (xp) => 1 + Math.floor(Math.sqrt(xp / 60));
export const xpForLevel = (level) => 60 * (level - 1) ** 2;

// ---- looks --------------------------------------------------------------------------------------------------------
export const LOOK = {
  skin: ['#f3cfa8', '#e0ac7e', '#c68a5c', '#9c6841', '#6e4428', '#4a2d1a'],
  hairStyle: ['Kaal', 'Kort', 'Lang', 'Hanenkam'],
  hair: ['#1b1614', '#4a2f1c', '#8a5a2b', '#d8b24a', '#b8402c', '#e9e7e1', '#3d6fd6', '#d24fa8'],
  eyes: ['#2b6fd6', '#3f9a4d', '#6b4526', '#20e7b7', '#8f8f8f', '#b63a3a'],
  shirt: ['#d8483c', '#e8862e', '#e8c63a', '#58b04a', '#20b89a', '#3f7fd8', '#6a52c8', '#c24a9c', '#e9e7e1', '#2a2c2b'],
  shirtStyle: ['Effen', 'Strepen', 'Vlak'],
  pants: ['#2f3f6e', '#3a3a3a', '#6b4a2c', '#7a7f85', '#28523a', '#5a2f3f', '#d8d4c8', '#16181a'],
  cape: ['Geen', 'Effen', 'Strepen', 'Kruis', 'Ruit', 'Bliksem', 'Zon', 'Vlam', 'Regenboog'],
  capeColor: ['#d8483c', '#e8862e', '#e8c63a', '#58b04a', '#20e7b7', '#3f7fd8', '#6a52c8', '#c24a9c', '#e9e7e1', '#1b1d1c'],
  hat: ['Geen', 'Pet', 'Kroon', 'Hoorns', 'Band', 'Hoge hoed', 'Halo'],
};
export const DEFAULT_LOOK = { skin: 1, hairStyle: 1, hair: 1, eyes: 0, shirt: 5, shirtStyle: 0, pants: 0, cape: 0, capeColor: 0, hat: 0 };
export const BOT_NAMES = ['Mika', 'Bram', 'Lotte', 'Sem', 'Noor', 'Finn', 'Roos', 'Daan', 'Jip', 'Saar', 'Teun', 'Evi'];
