// BLOKSTORM - every picture in the game is drawn here, pixel by pixel, on small canvases. No image files.
import { ITEMS, BLOCKS, LOOK } from './config.js';
import { rng, shade } from './util.js';

const T = 16;
export const ATLAS_COLS = 8, ATLAS_ROWS = 4;   // 128 x 64: a power of two, so the far-away versions stay clean

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}
function px(g, x, y, color) { g.fillStyle = color; g.fillRect(x, y, 1, 1); }
function speckle(g, ox, oy, w, h, colors, rand) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(g, ox + x, oy + y, colors[Math.floor(rand() * colors.length)]);
}

// ---- block atlas --------------------------------------------------------------------------------------------------
let atlas = null;
export function blockAtlas() {
  if (atlas) return atlas;
  const [c, g] = canvas(T * ATLAS_COLS, T * ATLAS_ROWS);
  const rand = rng(7331);
  const at = (i) => [(i % ATLAS_COLS) * T, Math.floor(i / ATLAS_COLS) * T];
  const grass = ['#5fae45', '#58a53f', '#69b84c', '#4f9a3a'];
  const dirt = ['#7a5536', '#6f4c30', '#84603f', '#664529'];
  const stone = ['#8b8f8d', '#7f8381', '#959997', '#747876'];
  let [x, y] = at(0); speckle(g, x, y, T, T, grass, rand);
  [x, y] = at(1); speckle(g, x, y, T, T, dirt, rand); speckle(g, x, y, T, 3, grass, rand);
  for (let i = 0; i < T; i++) if (rand() < 0.5) px(g, x + i, y + 3, grass[i % 4]);
  [x, y] = at(2); speckle(g, x, y, T, T, dirt, rand);
  [x, y] = at(3); speckle(g, x, y, T, T, stone, rand);
  for (let i = 0; i < 5; i++) { g.fillStyle = '#6a6e6c'; g.fillRect(x + Math.floor(rand() * 13), y + Math.floor(rand() * 14), 3, 1); }
  [x, y] = at(4); speckle(g, x, y, T, T, ['#b98a4e', '#b08247', '#c19356'], rand);
  g.fillStyle = '#8a6434'; for (let r = 3; r < T; r += 4) g.fillRect(x, y + r, T, 1);
  for (let r = 0; r < 4; r++) px(g, x + ((r * 7 + 3) % T), y + r * 4 + 1, '#8a6434');
  [x, y] = at(5); speckle(g, x, y, T, T, ['#e9e7e1', '#dedcd5', '#f2f0ea', '#d4d2ca'], rand);
  // core stone: the spawn islands, cannot break
  [x, y] = at(6); speckle(g, x, y, T, T, ['#22302e', '#1e2a28', '#263634'], rand);
  g.strokeStyle = '#3d5552'; g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
  for (const [a, b] of [[2, 2], [13, 2], [2, 13], [13, 13]]) px(g, x + a, y + b, '#20e7b7');
  [x, y] = at(7); speckle(g, x, y, T, T, ['#22302e', '#1e2a28', '#263634'], rand);
  g.fillStyle = '#3d5552'; g.fillRect(x, y, T, 1); g.fillRect(x, y + 15, T, 1); g.fillRect(x, y + 7, T, 1);
  for (let i = 1; i < T; i += 5) px(g, x + i, y + 4, '#20e7b7');
  // generator top and side
  [x, y] = at(8); g.fillStyle = '#14191a'; g.fillRect(x, y, T, T);
  g.fillStyle = '#3d5552'; g.fillRect(x + 1, y + 1, 14, 14); g.fillStyle = '#14191a'; g.fillRect(x + 3, y + 3, 10, 10);
  g.fillStyle = '#20e7b7'; g.fillRect(x + 5, y + 5, 6, 6); g.fillStyle = '#bafbe9'; g.fillRect(x + 7, y + 7, 2, 2);
  [x, y] = at(9); g.fillStyle = '#14191a'; g.fillRect(x, y, T, T);
  g.fillStyle = '#3d5552'; g.fillRect(x, y, T, 2); g.fillRect(x, y + 14, T, 2);
  g.fillStyle = '#20e7b7'; for (let i = 2; i < T; i += 4) g.fillRect(x + i, y + 4, 2, 8);
  [x, y] = at(10); g.fillStyle = '#9a9186'; g.fillRect(x, y, T, T);
  for (let r = 0; r < 4; r++) for (let b = -1; b < 3; b++) {
    const bx = b * 8 + (r % 2) * 4;
    g.fillStyle = ['#a8483a', '#b3523f', '#9c4034'][Math.floor(rand() * 3)];
    g.fillRect(x + Math.max(0, bx), y + r * 4, Math.min(7, T - Math.max(0, bx), bx + 7), 3);
  }
  [x, y] = at(11); speckle(g, x, y, T, T, ['#b98a4e', '#a87a42'], rand);
  g.strokeStyle = '#5b3f22'; g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1); g.strokeStyle = '#8a6434'; g.strokeRect(x + 4.5, y + 4.5, 7, 7);
  [x, y] = at(12); speckle(g, x, y, T, T, ['#5b3f22', '#523820', '#65472a'], rand);
  g.fillStyle = '#463018'; for (let i = 2; i < T; i += 5) g.fillRect(x + i, y, 1, T);
  [x, y] = at(13); speckle(g, x, y, T, T, ['#3f8a35', '#35782d', '#4a9a3e', '#2c6a26'], rand);
  [x, y] = at(14); speckle(g, x, y, T, T, ['#2a2433', '#241f2c', '#30293a', '#1d1924'], rand);
  for (let i = 0; i < 4; i++) px(g, x + Math.floor(rand() * T), y + Math.floor(rand() * T), '#6a52c8');
  // chest: lid, side with a lock, and the open top
  const wood = ['#a9762f', '#9c6b29', '#b58236'];
  [x, y] = at(15); speckle(g, x, y, T, T, wood, rand);
  g.strokeStyle = '#4a2f12'; g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1); g.fillStyle = '#4a2f12'; g.fillRect(x, y + 7, T, 2);
  g.fillStyle = '#e8c63a'; g.fillRect(x + 6, y + 6, 4, 4);
  [x, y] = at(16); speckle(g, x, y, T, T, wood, rand);
  g.strokeStyle = '#4a2f12'; g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1); g.fillStyle = '#4a2f12'; g.fillRect(x, y + 5, T, 1);
  g.fillStyle = '#c9ced2'; g.fillRect(x + 6, y + 3, 4, 5); g.fillStyle = '#e8c63a'; g.fillRect(x + 7, y + 5, 2, 2);
  [x, y] = at(17); speckle(g, x, y, T, T, wood, rand);
  g.fillStyle = '#4a2f12'; g.fillRect(x + 1, y + 1, 14, 14); g.fillStyle = '#1d1208'; g.fillRect(x + 2, y + 2, 12, 12);
  // bounce block
  [x, y] = at(18); speckle(g, x, y, T, T, ['#6fd65a', '#63c94f', '#7be066'], rand);
  g.strokeStyle = '#3f9a35'; g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1); g.fillStyle = '#b6f5a8'; g.fillRect(x + 4, y + 4, 8, 8); g.fillStyle = '#6fd65a'; g.fillRect(x + 6, y + 6, 4, 4);
  // gold block
  [x, y] = at(19); speckle(g, x, y, T, T, ['#f2cf3e', '#e8c63a', '#f8dc58', '#dcb630'], rand);
  g.fillStyle = '#b8922a'; g.fillRect(x, y + 15, T, 1); g.fillRect(x + 15, y, 1, T);
  g.fillStyle = '#fff3a8'; g.fillRect(x, y, T, 1); g.fillRect(x, y, 1, T); g.fillRect(x + 3, y + 3, 3, 1);
  atlas = c;
  return c;
}
/** UV rectangle [u0, v0, u1, v1] of a tile, with v pointing up like three.js wants. */
export function tileUV(i) {
  const e = 0.002;
  const cx = i % ATLAS_COLS, cy = Math.floor(i / ATLAS_COLS);
  return [cx / ATLAS_COLS + e, 1 - (cy + 1) / ATLAS_ROWS + e, (cx + 1) / ATLAS_COLS - e, 1 - cy / ATLAS_ROWS - e];
}

// ---- item sprites -------------------------------------------------------------------------------------------------
const SHAPES = {
  sword: ['..............bb', '.............bcb', '............bccb', '...........bccb.', '..........bccb..', '.........bccb...',
    '........bccb....', '..h....bccb.....', '..hh..bccb......', '...hhbccb.......', '....hhcb........', '....hhh.........',
    '...ss.hh........', '..ss...hh.......', '.ss.............', 'ss..............'],
  bat: ['............ww..', '...........wwww.', '..........wwwww.', '.........wwwwww.', '........wwwwww..', '.......wwwwww...',
    '......wwwwww....', '.....wwwww......', '....dwwww.......', '...dwww.........', '..ddww..........', '.ddd............',
    'ddd.............', 'dd..............'],
  pickaxe: ['....mmmmmm......', '..mmmmmmmmmm....', '.mm.....smmmm...', 'm.......ssmmm...', '.......ss..mm...', '......ss...mm...',
    '.....ss.....m...', '....ss......m...', '...ss...........', '..ss............', '.ss.............', 'ss..............'],
  bow: ['.....www', '....w..s', '...w...s', '..w....s', '.w.....s', '.w.....s', 'w......s', 'w......s', 'w......s', 'w......s',
    '.w.....s', '.w.....s', '..w....s', '...w...s', '....w..s', '.....www'],
  arrow: ['............ttt', '............ttt', '...........sttt', '..........s....', '.........s.....', '........s......',
    '.......s.......', '......s........', '.....s.........', '....s..........', '.f.s...........', '.ffs...........',
    'fff............', '.ff............'],
  rock: ['....gggg....', '..gggGGggg..', '.ggGGGGGggg.', '.gGGGGGgggd.', 'ggGGGggggdd.', 'gggGgggggdd.', 'gggggggdddd.',
    '.ggggdddddd.', '.gdddddddd..', '..dddddd....'],
  bomb: ['........ff..', '.......f..y.', '......f...o.', '...kkkk.....', '..kkkkkkk...', '.kkwwkkkkk..', 'kkwwkkkkkkk.',
    'kkwkkkkkkkk.', 'kkkkkkkkkkk.', 'kkkkkkkkkkk.', 'kkkkkkkkkkk.', '.kkkkkkkkk..', '..kkkkkkk...', '...kkkk.....'],
  warp: ['....pppp....', '..ppPPPPpp..', '.pPPwwPPPPp.', '.pPwwPPPPPp.', 'pPPwPPPPPPPp', 'pPPPPPqqPPPp', 'pPPPPqqqPPPp',
    'pPPPPPqqPPPp', '.pPPPPPPPPp.', '.pPPPPPPPPp.', '..ppPPPPpp..', '....pppp....'],
  apple: ['.......s....', '......sl....', '.....s.ll...', '..aaa.aaa...', '.aaAAaaaaa..', 'aaAAaaaaaaa.', 'aaAaaaaaaaa.',
    'aaaaaaaaaaa.', 'aaaaaaaaaad.', 'aaaaaaaaadd.', '.aaaaaaadd..', '.aaaaaaddd..', '..aaa.ddd...'],
  potion: ['...cccc...', '....gg....', '....gg....', '....gg....', '...gggg...', '..gLLLLg..', '.gLLLLLLg.', 'gLwLLLLLLg',
    'gLwLLLLLLg', 'gLLLLLLLLg', 'gLLLLLLLLg', '.gLLLLLLg.', '..gggggg..'],
  wind: ['....cccc....', '..cc....cc..', '.c..wwww..c.', 'c..w....w..c', 'c.w..cc..w.c', 'c.w.c..c.w.c', 'c.w.c..c.w.c',
    'c.w..cc..w.c', 'c..w....w..c', '.c..wwww..c.', '..cc....cc..', '....cccc....'],
  spear: ['.............tt', '............ttt', '...........ttt.', '..........stt..', '.........s.....', '........s......', '.......s.......',
    '......s........', '.....s.........', '....s..........', '...s...........', '..s............', '.s.............', 's..............'],
  axe: ['......mmm.....', '.....mmmmm....', '....mmmmmms...', '....mmmmss....', '.....mmss.....', '......ss......', '.....ss.......',
    '....ss........', '...ss.........', '..ss..........', '.ss...........', 'ss............'],
  fire: ['.....y......', '....yy..y...', '...yoo.yy...', '..yooooyo...', '.yoorroooy..', '.yorrrrroy..', 'yoorrwrrooy.', 'yorrwwwrroy.',
    'yoorwwwrooy.', '.yorrrrroy..', '..yoooooy...', '...yyyyy....'],
  hook: ['.........hhhh.', '........h...h.', '.......h....h.', '......hh...h..', '.....hh.......', '....rr........', '...rr.........',
    '..rr..........', '.rr...........', 'rr............', 'r.............'],
  totem: ['...gggggg...', '..gGGGGGGg..', '.gGeGGGGeGg.', '.gGGGGGGGGg.', '..gGGmmGGg..', 'ggggGGGGgggg', 'gGGgGGGGgGGg', '.gggGGGGggg.',
    '...gGGGGg...', '...gGggGg...', '...gGg.gGg..', '...ggg.ggg..'],
  vest: ['..vv......vv..', '.vvvv....vvvv.', 'vvvvvv..vvvvvv', 'vvvvvvvvvvvvvv', 'vvVvvvvvvvvVvv', '.vVvvvvvvvvVv.', '..VvvvvvvvvV..',
    '..VvvvvvvvvV..', '..VvvvvvvvvV..', '..VvvvddvvvV..', '..VvvvddvvvV..', '..VvvvvvvvvV..', '..VVVVVVVVVV..'],
};
const WOOD = { h: '#5b3f22', s: '#8a6434' };
const SPRITES = {
  sword_wood: ['sword', { b: '#6f4c30', c: '#b98a4e', ...WOOD }],
  sword_stone: ['sword', { b: '#5c605e', c: '#9da19f', ...WOOD }],
  sword_iron: ['sword', { b: '#8e969c', c: '#e3e8ec', ...WOOD }],
  sword_crystal: ['sword', { b: '#12a583', c: '#8ff5dc', h: '#22302e', s: '#3d5552' }],
  pickaxe: ['pickaxe', { m: '#9da19f', s: '#8a6434' }],
  spear: ['spear', { t: '#c9ced2', s: '#8a6434' }],
  axe: ['axe', { m: '#aeb4b8', s: '#8a6434' }],
  fire: ['fire', { y: '#f8eaa0', o: '#e8862e', r: '#d8483c', w: '#fff3c4' }],
  hook: ['hook', { h: '#aeb4b8', r: '#8a6434' }],
  totem: ['totem', { g: '#b8922a', G: '#e8c63a', e: '#20e7b7', m: '#8a6434' }],
  bow: ['bow', { w: '#8a6434', s: '#e9e7e1' }],
  arrow: ['arrow', { t: '#c9ced2', s: '#8a6434', f: '#e9e7e1' }],
  rock: ['rock', { g: '#8b8f8d', G: '#a9adab', d: '#646866' }],
  bomb: ['bomb', { k: '#1b1d1c', w: '#5d6462', f: '#8a6434', y: '#e8c63a', o: '#e8862e' }],
  warp: ['warp', { p: '#3b2a7a', P: '#6a52c8', w: '#c9bdf5', q: '#20e7b7' }],
  apple: ['apple', { a: '#d8483c', A: '#f08a7c', d: '#a8322a', s: '#5b3f22', l: '#58b04a' }],
  apple_gold: ['apple', { a: '#e8c63a', A: '#f8eaa0', d: '#b8922a', s: '#5b3f22', l: '#58b04a' }],
  potion_heal: ['potion', { c: '#8a6434', g: '#c9ced2', L: '#d8483c', w: '#f5b3ac' }],
  potion_speed: ['potion', { c: '#8a6434', g: '#c9ced2', L: '#3f7fd8', w: '#b5cff5' }],
  potion_jump: ['potion', { c: '#8a6434', g: '#c9ced2', L: '#58b04a', w: '#c0eab8' }],
  potion_slowfall: ['potion', { c: '#8a6434', g: '#c9ced2', L: '#b9a8ee', w: '#efe9ff' }],
  wind: ['wind', { c: '#8fd3e2', w: '#e9fbff' }],
  vest_leather: ['vest', { v: '#8a5a2b', V: '#6b4420', d: '#4a2f1c' }],
  vest_iron: ['vest', { v: '#c9ced2', V: '#8e969c', d: '#5c666e' }],
  vest_crystal: ['vest', { v: '#3fd9b6', V: '#12a583', d: '#0c6e58' }],
};

const itemCache = new Map();
/** A 16x16 canvas with the item drawn on it. */
export function itemCanvas(id) {
  if (itemCache.has(id)) return itemCache.get(id);
  const [c, g] = canvas(T, T);
  const def = ITEMS[id];
  if (def && def.kind === 'block') {
    const tile = BLOCKS[def.block].side;
    g.fillStyle = '#0b0c0c'; g.fillRect(1, 1, 14, 14);
    g.drawImage(blockAtlas(), (tile % ATLAS_COLS) * T, Math.floor(tile / ATLAS_COLS) * T, T, T, 2, 2, 12, 12);
    g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(2, 2, 12, 1);
    g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(2, 13, 12, 1); g.fillRect(13, 2, 1, 12);
  } else if (SPRITES[id]) {
    const [shape, pal] = SPRITES[id];
    const rows = SHAPES[shape];
    const w = Math.max(...rows.map((r) => r.length));
    const ox = Math.floor((T - w) / 2), oy = Math.floor((T - rows.length) / 2);
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (pal[row[x]]) px(g, ox + x, oy + y, pal[row[x]]); });
    outline(g);
  }
  itemCache.set(id, c);
  return c;
}
/** Dark 1 pixel outline around a sprite so it reads on any background. */
function outline(g) {
  const src = g.getImageData(0, 0, T, T), d = src.data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < T && y < T && d[(y * T + x) * 4 + 3] > 0;
  // the outline takes a dark shade of the pixel next to it, so a sword gets a dark steel edge instead of a black one
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    if (solid(x, y)) continue;
    const n = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].find(([a, b]) => solid(a, b));
    if (!n) continue;
    const i = (n[1] * T + n[0]) * 4;
    g.fillStyle = `rgb(${Math.round(d[i] * 0.32)},${Math.round(d[i + 1] * 0.32)},${Math.round(d[i + 2] * 0.34)})`;
    g.fillRect(x, y, 1, 1);
  }
}
// ---- status icons: hearts, stamina bolts, armour ----
const ICONS = {
  heart: ['.XX...XX.', 'XXXX.XXXX', 'XXXXXXXXX', 'XXXXXXXXX', '.XXXXXXX.', '..XXXXX..', '...XXX...', '....X....'],
  bolt: ['....XXX..', '...XXX...', '..XXX....', '.XXXXXX..', '...XXX...', '..XXX....', '.XXX.....', '.X.......'],
  armor: ['XX.....XX', 'XXX.X.XXX', 'XXXXXXXXX', '.XXXXXXX.', '.XXXXXXX.', '.XXXXXXX.', '..XXXXX..', '.........'],
};
const ICON_COLORS = { heart: ['#e5484d', '#ff9a9d'], bolt: ['#e8c63a', '#fff3a8'], armor: ['#c9ced2', '#ffffff'] };
const iconCache = new Map();
/** state: 2 = full, 1 = half, 0 = empty. Returns a data URL of an 11 x 10 pixel icon with a dark outline. */
export function hudIcon(kind, state) {
  const key = kind + state;
  if (iconCache.has(key)) return iconCache.get(key);
  const rows = ICONS[kind], [c, g] = canvas(11, 10), [col, light] = ICON_COLORS[kind];
  const on = (x, y) => y >= 0 && y < rows.length && rows[y][x] === 'X';
  for (let y = -1; y <= rows.length; y++) for (let x = -1; x <= 9; x++) {
    if (on(x, y)) px(g, x + 1, y + 1, state === 2 || (state === 1 && x < 5) ? col : '#2a2c2b');
    else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) px(g, x + 1, y + 1, '#0b0c0c');
  }
  if (state > 0) { px(g, 2, 2, light); px(g, 3, 2, light); px(g, 2, 3, light); }
  iconCache.set(key, c.toDataURL());
  return iconCache.get(key);
}

const urlCache = new Map();
/** Picture for the hotbar and menus. Blocks are drawn as a little 3D cube, everything else as its flat sprite. */
export function itemURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const def = ITEMS[id];
  let c = itemCanvas(id);
  if (def && def.kind === 'block') {
    const b = BLOCKS[def.block], at = blockAtlas();
    let g; [c, g] = canvas(32, 32);
    const face = (tile, m, dark) => {
      g.setTransform(...m);
      g.drawImage(at, (tile % ATLAS_COLS) * T, Math.floor(tile / ATLAS_COLS) * T, T, T, 0, 0, T, T);
      if (dark) { g.fillStyle = `rgba(0,0,0,${dark})`; g.fillRect(0, 0, T, T); }
    };
    face(b.top, [1, 0.5, -1, 0.5, 16, 0], 0);
    face(b.side, [1, 0.5, 0, 1, 0, 8], 0.22);
    face(b.side, [1, -0.5, 0, 1, 16, 16], 0.42);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  urlCache.set(id, c.toDataURL());
  return urlCache.get(id);
}

// ---- character skin -----------------------------------------------------------------------------------------------
// Layout in pixels (x, y, w, h). avatar.js maps the box faces onto these rectangles.
export const SKIN = {
  W: 64, H: 40,
  head: { front: [0, 0, 8, 8], back: [8, 0, 8, 8], right: [16, 0, 8, 8], left: [24, 0, 8, 8], top: [32, 0, 8, 8], bottom: [40, 0, 8, 8] },
  body: { front: [0, 8, 8, 12], back: [8, 8, 8, 12], right: [16, 8, 4, 12], left: [16, 8, 4, 12], top: [20, 8, 8, 4], bottom: [20, 12, 8, 4] },
  arm: { front: [32, 8, 4, 12], back: [36, 8, 4, 12], right: [40, 8, 4, 12], left: [44, 8, 4, 12], top: [48, 8, 4, 4], bottom: [48, 12, 4, 4] },
  leg: { front: [0, 20, 4, 12], back: [4, 20, 4, 12], right: [8, 20, 4, 12], left: [8, 20, 4, 12], top: [12, 20, 4, 4], bottom: [12, 24, 4, 4] },
  cape: { front: [26, 20, 10, 16], back: [16, 20, 10, 16], right: [36, 20, 1, 16], left: [36, 20, 1, 16], top: [36, 20, 1, 1], bottom: [36, 20, 1, 1] },
  hatA: [56, 0, 4, 4], hatB: [60, 0, 4, 4], hair: [56, 4, 4, 4],
};

export function drawSkin(look) {
  const [c, g] = canvas(SKIN.W, SKIN.H);
  const pick = (key) => LOOK[key][look[key] % LOOK[key].length];
  const skin = pick('skin'), hair = pick('hair'), eyes = pick('eyes'), shirt = pick('shirt'), pants = pick('pants');
  const rand = rng(1234 + look.skin * 7 + look.shirt * 13 + look.pants * 31);
  const fill = (r, color, vary = 0.06) => {
    for (let y = 0; y < r[3]; y++) for (let x = 0; x < r[2]; x++) px(g, r[0] + x, r[1] + y, shade(color, 1 - vary + rand() * vary * 2));
  };
  // head
  for (const k of Object.keys(SKIN.head)) fill(SKIN.head[k], skin);
  const f = SKIN.head.front;
  px(g, f[0] + 1, f[1] + 4, '#f4f2ec'); px(g, f[0] + 2, f[1] + 4, eyes); px(g, f[0] + 5, f[1] + 4, eyes); px(g, f[0] + 6, f[1] + 4, '#f4f2ec');
  g.fillStyle = shade(skin, 0.72); g.fillRect(f[0] + 3, f[1] + 6, 2, 1);
  const style = look.hairStyle % 4;
  const hairRect = (r, x, y, w, h) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(g, r[0] + x + i, r[1] + y + j, shade(hair, 0.9 + rand() * 0.2)); };
  if (style === 1 || style === 2) {
    hairRect(SKIN.head.top, 0, 0, 8, 8);
    hairRect(SKIN.head.front, 0, 0, 8, 2); px(g, f[0], f[1] + 2, hair); px(g, f[0] + 7, f[1] + 2, hair);
    const long = style === 2 ? 8 : 4;
    hairRect(SKIN.head.back, 0, 0, 8, long); hairRect(SKIN.head.left, 0, 0, 8, style === 2 ? 7 : 3); hairRect(SKIN.head.right, 0, 0, 8, style === 2 ? 7 : 3);
  } else if (style === 3) {
    hairRect(SKIN.head.top, 3, 0, 2, 8); hairRect(SKIN.head.front, 3, 0, 2, 2); hairRect(SKIN.head.back, 3, 0, 2, 4);
  }
  // body and arms
  for (const k of Object.keys(SKIN.body)) fill(SKIN.body[k], shirt);
  const st = look.shirtStyle % 3;
  for (const k of ['front', 'back']) {
    const r = SKIN.body[k];
    if (st === 1) { g.fillStyle = shade(shirt, 0.62); for (let y = 1; y < 12; y += 3) g.fillRect(r[0], r[1] + y, 8, 1); }
    if (st === 2 && k === 'front') { g.fillStyle = shade(shirt, 1.45); g.fillRect(r[0] + 2, r[1] + 3, 4, 4); }
  }
  g.fillStyle = shade(skin, 0.9); g.fillRect(SKIN.body.front[0] + 3, SKIN.body.front[1], 2, 1);
  for (const k of Object.keys(SKIN.arm)) {
    const r = SKIN.arm[k];
    fill(r, skin);
    if (k !== 'bottom') fill([r[0], r[1], r[2], Math.min(r[3], 5)], shirt);
  }
  // legs with shoes
  for (const k of Object.keys(SKIN.leg)) fill(SKIN.leg[k], pants);
  for (const k of ['front', 'back', 'right']) { const r = SKIN.leg[k]; fill([r[0], r[1] + 10, r[2], 2], '#2a2c2b'); }
  fill(SKIN.leg.bottom, '#2a2c2b');
  // cape
  drawCape(g, look, rand);
  // hat and hair swatches
  const hatCols = [['#000', '#000'], [shirt, '#e9e7e1'], ['#e8c63a', '#d8483c'], ['#e9e7e1', '#b8b4a8'], [pick('capeColor'), '#e9e7e1'], ['#16181a', pick('capeColor')], ['#f8eaa0', '#e8c63a']][look.hat % LOOK.hat.length];
  fill(SKIN.hatA, hatCols[0], 0.04); fill(SKIN.hatB, hatCols[1], 0.04); fill(SKIN.hair, hair, 0.05);
  return c;
}

function drawCape(g, look, rand) {
  const col = LOOK.capeColor[look.capeColor % LOOK.capeColor.length];
  const light = shade(col, 1.5), dark = shade(col, 0.55);
  const [x0, y0, w, h] = SKIN.cape.back;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = col;
    const design = look.cape % LOOK.cape.length;
    if (design === 7) { const hgt = 6 + ((x * 7) % 5); if (y > h - hgt) c = y > h - hgt + 3 ? '#f8eaa0' : '#e8862e'; }
    if (design === 8) c = ['#d8483c', '#e8862e', '#e8c63a', '#58b04a', '#3f7fd8', '#6a52c8'][Math.floor(y / 2.7) % 6];
    if (design === 2 && y % 4 < 2) c = light;
    if (design === 3 && (x === 4 || x === 5 || y === 5 || y === 6)) c = light;
    if (design === 4 && (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0) c = dark;
    if (design === 5) { const bx = [6, 5, 4, 3, 4, 5, 6, 5, 4, 3][y - 3]; if (bx !== undefined && (x === bx || x === bx + 1)) c = '#f8eaa0'; }
    if (design === 6) { const dx = x - 4.5, dy = y - 7.5, d = Math.hypot(dx, dy); if (d < 2.6) c = '#f8eaa0'; else if (d < 5 && (Math.abs(dx) < 0.6 || Math.abs(dy) < 0.6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.6)) c = light; }
    if (x === 0 || x === w - 1 || y === h - 1) c = dark;
    px(g, x0 + x, y0 + y, shade2(c, 0.95 + rand() * 0.1));
  }
  const [ix, iy] = SKIN.cape.front;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(g, ix + x, iy + y, dark);
  px(g, SKIN.cape.right[0], SKIN.cape.right[1], dark);
  g.fillStyle = dark; g.fillRect(SKIN.cape.right[0], SKIN.cape.right[1], 1, 16);
}
function shade2(c, f) {
  if (c[0] === '#') return shade(c, f);
  const m = c.match(/\d+/g).map(Number);
  return `rgb(${Math.min(255, Math.round(m[0] * f))},${Math.min(255, Math.round(m[1] * f))},${Math.min(255, Math.round(m[2] * f))})`;
}
