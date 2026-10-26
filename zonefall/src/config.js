// ZONEFALL - central tunables. OWNER: LEAD (read-only for builders; see ARCHITECTURE.md section 11).
// Units: metres, seconds, degrees where a key ends in Deg, milliseconds where a key ends in Ms.

export const VERSION = '1.0.0';
export const GAME_NAME = 'ZONEFALL';

// ---------------------------------------------------------------- paths
// Resolved against this module, so pages in /dev/ and the root page load the same files.
export const ASSET_BASE = new URL('../assets/', import.meta.url).href;
export const assetUrl = (path) => ASSET_BASE + path;

// ---------------------------------------------------------------- dev / test switches (URL query)
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const num = (k) => (Q.has(k) && Q.get(k) !== '' && Number.isFinite(+Q.get(k)) ? +Q.get(k) : null);
export const DEV = Object.freeze({
  quality: Q.get('quality'),            // 'low' | 'medium' | 'high' forces a tier for this session
  practice: Q.has('practice'),          // boot straight into a practice match (skips menu)
  seed: num('seed'),                    // fixed match seed (practice and host)
  bots: num('bots'),                    // bot count override for practice/host fill
  skipPlane: Q.has('skipplane'),        // spawn on the ground at DEV.spawn instead of the plane
  spawn: Q.get('spawn'),                // POI id for skipplane, e.g. 'harrow'
  mute: Q.has('mute'),                  // start muted
  room: Q.get('room'),                  // auto-join private room code
  name: Q.get('name'),                  // callsign override
  debug: Q.has('debug'),                // stats overlay + bus warnings for unknown events
  fastZone: Q.has('fastzone'),          // zone timings x0.1 (tests)
  noPost: Q.has('nopost'),              // disable post chain regardless of tier
});

// ---------------------------------------------------------------- surfaces (footsteps, impacts, decals)
export const SURFACE = Object.freeze({
  GRASS: 0, DIRT: 1, ROCK: 2, CONCRETE: 3, ASPHALT: 4, WOOD: 5, METAL: 6, WATER: 7, SAND: 8, FLESH: 9, GLASS: 10,
});
export const SURFACE_NAME = Object.freeze(Object.fromEntries(Object.entries(SURFACE).map(([k, v]) => [v, k.toLowerCase()])));

// ---------------------------------------------------------------- assets (paths relative to ASSET_BASE)
export const ASSETS = Object.freeze({
  models: {
    soldier_a: 'characters/soldier_a.glb',      // 43 clips, WeaponSocket_R
    soldier_b: 'characters/soldier_b.glb',      // same skeleton, no clips
    ak47: 'weapons/stein/ak47.glb',
    m4a1: 'weapons/cc0pack/m4a1.glb',
    mp5: 'weapons/stein/mp5.glb',
    m700: 'weapons/stein/m700.glb',
    sniper_scope: 'weapons/cc0pack/sniper.glb', // only its 'Scope' node is used, mounted on the M700
    m1911: 'weapons/stein/1911.glb',
    frag: 'weapons/cc0pack/frag_grenade.glb',
    crate_military: 'props/polyhaven/wooden_military_crate.glb',
    crate_old: 'props/polyhaven/old_military_crate.glb',
    ammo_box: 'props/polyhaven/ammo_box.glb',
    jerrycan: 'props/polyhaven/metal_jerrycan_green.glb',
    medical_box: 'props/polyhaven/medical_box.glb',
    barrel_red: 'props/polyhaven/Barrel_01.glb',
    barrel_blue: 'props/polyhaven/barrel_03.glb',
    barrier: 'props/polyhaven/concrete_road_barrier_02.glb',
    tyre: 'props/polyhaven/old_tyre.glb',
    generator: 'props/polyhaven/portable_generator.glb',
    covered_car: 'props/polyhaven/covered_car.glb',
    crate_wood: 'props/polyhaven/wooden_crate_02.glb',
    cardboard_box: 'props/polyhaven/cardboard_box_01.glb',
    utility_box: 'props/polyhaven/utility_box_01.glb',
  },
  // Poly Haven PBR sets: textures/<id>/<id>_{diff,nor_gl,arm}_1k.jpg ; value = real-world tile size in metres
  textures: {
    sparse_grass: 2, leafy_grass: 2, forrest_ground_01: 2, brown_mud_02: 1.3, rocky_terrain_02: 90,
    gravelly_sand: 2.5, asphalt_02: 3, concrete_floor_worn_001: 3, concrete_wall_008: 2.7, red_brick_03: 1,
    corrugated_iron: 1.1, weathered_brown_planks: 1.8, green_metal_rust: 1,
  },
  hdri: {
    day: { hdr: 'hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr', bg: 'hdri/kloofendal_48d_partly_cloudy_puresky_bg_4k.jpg' },
    sunset: { hdr: 'hdri/industrial_sunset_02_puresky_1k.hdr', bg: 'hdri/industrial_sunset_02_puresky_bg_4k.jpg' },
  },
});
export const textureUrl = (id, map) => assetUrl(`textures/${id}/${id}_${map}_1k.jpg`); // map: 'diff' | 'nor_gl' | 'arm'

// Audio: name -> number of variants (0 = single file '<name>.mp3', n = '<name>_0..n-1.mp3'), all in assets/audio/
export const AUDIO = Object.freeze({
  gun_rifle: 4, gun_pistol: 4, gun_sniper: 3,
  rifle_mag_out: 0, rifle_mag_in: 0, rifle_charge: 0, pistol_mag_out: 0, pistol_mag_in: 0, bolt_cycle: 0, dry_fire: 1,
  footstep_concrete: 5, footstep_grass: 5, footstep_wood: 5, footstep_gravel: 5,
  impact_metal: 4, impact_wood: 3, impact_concrete: 3, impact_dirt: 3, impact_rock: 3, impact_glass: 3,
  hit_body: 4, hit_armor: 3, armor_break: 0, plate_insert: 0, casing: 3, land: 2,
  grenade_pin: 0, grenade_bounce: 2, explosion: 2, whizz: 2, pickup: 0,
  wind_loop: 0, plane_loop: 0, freefall_loop: 0, chute_loop: 0, chute_open: 0, zone_hum_loop: 0, zone_warning: 0, heartbeat_loop: 0,
  ui_hover: 0, ui_click: 0, ui_confirm: 0, ui_back: 0, ui_error: 0, ui_tick: 0, ui_go: 0,
  hitmarker: 0, hitmarker_head: 0, kill_confirm: 0,
});
export const audioUrl = (file) => assetUrl(`audio/${file}.mp3`);

// ---------------------------------------------------------------- rendering
export const RENDER = Object.freeze({
  sky: 'day',                 // ASSETS.hdri key
  exposure: 1.0,
  envIntensity: 0.85,
  sunIntensity: 3.0,
  sunColor: 0xfff0dc,
  sunDir: [-0.42, 0.74, 0.52], // world-space direction TO the sun; WORLD aligns it with the HDRI sun at load
  fogColor: 0xbfcad2,
  near: 0.05,
  far: 2400,
  menuFov: 50,
});

// Quality tiers. Auto-picked by renderer.detectTier(), overridable in settings and with ?quality=.
export const QUALITY = Object.freeze({
  low: {
    dprCap: 1.0, dprMin: 0.6, shadowMapSize: 1024, shadowRange: 50, post: false, smaa: false, bloom: false, ao: false,
    viewDistance: 520, fogDensity: 0.0028, foliage: 0.35, grass: 0, treeLodDistance: 110, propDistance: 140,
    maxAnimatedAvatars: 4, anisotropy: 2, terrainRes: 128, particles: 0.5, decals: 32, budgetDrawCalls: 120, budgetTris: 450e3,
  },
  medium: {
    dprCap: 1.25, dprMin: 0.75, shadowMapSize: 2048, shadowRange: 90, post: true, smaa: true, bloom: true, ao: false,
    viewDistance: 900, fogDensity: 0.0019, foliage: 0.7, grass: 0.5, treeLodDistance: 200, propDistance: 230,
    maxAnimatedAvatars: 8, anisotropy: 4, terrainRes: 256, particles: 0.8, decals: 64, budgetDrawCalls: 200, budgetTris: 900e3,
  },
  high: {
    dprCap: 1.5, dprMin: 0.85, shadowMapSize: 4096, shadowRange: 140, post: true, smaa: true, bloom: true, ao: true,
    viewDistance: 1300, fogDensity: 0.0014, foliage: 1.0, grass: 1.0, treeLodDistance: 320, propDistance: 330,
    maxAnimatedAvatars: 16, anisotropy: 8, terrainRes: 512, particles: 1, decals: 128, budgetDrawCalls: 300, budgetTris: 1.6e6,
  },
});
export const QUALITY_NAMES = Object.freeze(['low', 'medium', 'high']);

// ---------------------------------------------------------------- player
export const PLAYER = Object.freeze({
  height: 1.8, crouchHeight: 1.15, slideHeight: 0.95, radius: 0.32,
  eyeHeight: 1.64, crouchEyeHeight: 1.05, slideEyeHeight: 0.85,
  walkSpeed: 4.4, sprintSpeed: 6.9, crouchSpeed: 2.3, adsSpeedMult: 0.55,
  backwardMult: 0.8, strafeMult: 0.92,
  accelGround: 45, friction: 10, accelAir: 6, airControl: 0.25,
  gravity: 17, jumpVelocity: 5.6, stepHeight: 0.45, maxSlopeDeg: 46,
  slide: { minSpeed: 5.8, boost: 9.6, duration: 0.85, friction: 4.5, cooldown: 1.1 },
  mantle: { maxHeight: 1.35, minHeight: 0.5, reach: 0.7, duration: 0.45 },
  fall: { safeHeight: 4.5, lethalHeight: 16 },             // linear health damage between, armor ignored
  health: 100, regenDelay: 5.0, regenRate: 25,
  armor: { slots: 3, perPlate: 50, maxCarry: 5, insertTime: 1.15 },
  freefall: { gravity: 9.81, terminal: 32, diveTerminal: 52, glideSpeed: 26, turnRateDeg: 90, autoDeployAGL: 70, minDeployAGL: 22 },
  chute: { fallSpeed: 5.5, brakeFallSpeed: 3.8, forwardSpeed: 11.5, maxForward: 15, turnRateDeg: 70, openTime: 0.9, cutMinAGL: 12, redeployMinAGL: 28 },
  interactRange: 2.4,
  pitchLimitDeg: 85,
  mouseRadPerPx: 0.0022,     // at sensitivity 1.0
});

export const SPAWN_LOADOUT = Object.freeze({
  slots: [{ weapon: 'm1911', mag: 8 }, null],
  ammo: { ar: 0, light: 24, sniper: 0 },
  plates: 2,      // carried
  armor: 0,       // equipped armor points
  frags: 0,
});

// ---------------------------------------------------------------- weapons
export const AMMO = Object.freeze({
  ar: { name: '5.56/7.62', max: 240 },
  light: { name: '9MM/.45', max: 240 },
  sniper: { name: '.308', max: 40 },
});

// Index order used on the wire (u8). Never reorder without bumping NET.protocol.
export const WEAPON_ORDER = Object.freeze(['ak47', 'm4a1', 'mp5', 'm700', 'm1911', 'frag']);

// damage: piecewise-constant steps by distance [{d, dmg}] (body damage); head/limb are multipliers.
// recoil: degrees. Pattern for shot i (0-based) in a burst (see ARCHITECTURE.md 6.3):
//   pitch += vKick * (i===0 ? firstShot : 1) * (1 + vRamp * min(i, rampShots) / rampShots) * (ads ? 1 : hipMult)
//   yaw   += (hKick * sin(i * hFreq) + hBias + rand(-hJitter, hJitter)) * (ads ? 1 : hipMult)      (positive = right)
// After the trigger is released, autoRecover * (accumulated pitch) returns at `recover` deg/s.
export const WEAPONS = Object.freeze({
  ak47: {
    name: 'AK-47', class: 'ar', ammo: 'ar', mode: 'auto', rpm: 600, mag: 30,
    damage: [{ d: 0, dmg: 37 }, { d: 40, dmg: 30 }, { d: 60, dmg: 25 }], head: 1.5, limb: 0.9, range: 400,
    reload: 2.55, reloadEmpty: 3.1, reloadCues: { magout: 0.16, magin: 0.6, charge: 0.86 },
    ads: 0.30, sprintToFire: 0.26, raise: 0.6, mobility: 0.97, adsFovMult: 0.8,
    spread: { hip: 3.4, move: 1.6, ads: 0.12, bloom: 0.35, max: 6, recover: 9, air: 4 },
    recoil: { vKick: 0.62, vRamp: 0.45, rampShots: 7, hKick: 0.30, hFreq: 0.9, hBias: 0.05, hJitter: 0.12, firstShot: 1.5, hipMult: 1.3, recover: 10, autoRecover: 0.35, viewKickZ: 0.045, viewKickRotDeg: 2.6, shake: 0.35 },
    sound: { shot: 'gun_rifle', rate: 0.94, mech: 'rifle' },
    model: { key: 'ak47', muzzle: 'SOCKET_FX_FIRE', casing: 'SOCKET_FX_CASING', mag: 'MAGAZINE', bolt: 'SLIDE', sight: 'SOCKET_IRONSIGHT', rear: 'SOCKET_ATTACH_SCOPE', eye: [0, 0.144, -0.048] },
  },
  m4a1: {
    name: 'M4A1', class: 'ar', ammo: 'ar', mode: 'auto', rpm: 800, mag: 30,
    damage: [{ d: 0, dmg: 28 }, { d: 45, dmg: 24 }, { d: 70, dmg: 21 }], head: 1.4, limb: 0.9, range: 450,
    reload: 2.3, reloadEmpty: 2.85, reloadCues: { magout: 0.15, magin: 0.58, charge: 0.85 },
    ads: 0.26, sprintToFire: 0.22, raise: 0.55, mobility: 0.98, adsFovMult: 0.8,
    spread: { hip: 3.0, move: 1.4, ads: 0.08, bloom: 0.3, max: 5.5, recover: 10, air: 4 },
    recoil: { vKick: 0.42, vRamp: 0.3, rampShots: 6, hKick: 0.16, hFreq: 0.7, hBias: -0.03, hJitter: 0.08, firstShot: 1.35, hipMult: 1.25, recover: 12, autoRecover: 0.35, viewKickZ: 0.035, viewKickRotDeg: 1.9, shake: 0.25 },
    sound: { shot: 'gun_rifle', rate: 1.08, mech: 'rifle' },
    // No SOCKET_IRONSIGHT in this model: the sight line is given numerically (rear sight top ~ y 0.145).
    model: { key: 'm4a1', muzzle: 'SOCKET_FX_FIRE', casing: 'Ejector_Lid', mag: 'Magazine', bolt: 'Charging_Handle', sight: null, rear: 'Sight_2', eye: [0, 0.142, 0.08] },
  },
  mp5: {
    name: 'MP5', class: 'smg', ammo: 'light', mode: 'auto', rpm: 850, mag: 30,
    damage: [{ d: 0, dmg: 26 }, { d: 15, dmg: 21 }, { d: 30, dmg: 16 }], head: 1.35, limb: 0.9, range: 200,
    reload: 2.0, reloadEmpty: 2.6, reloadCues: { magout: 0.15, magin: 0.6, charge: 0.85 },
    ads: 0.20, sprintToFire: 0.16, raise: 0.45, mobility: 1.04, adsFovMult: 0.85,
    spread: { hip: 2.2, move: 0.8, ads: 0.15, bloom: 0.25, max: 4.2, recover: 12, air: 3 },
    recoil: { vKick: 0.30, vRamp: 0.25, rampShots: 8, hKick: 0.20, hFreq: 1.3, hBias: 0, hJitter: 0.14, firstShot: 1.2, hipMult: 1.1, recover: 14, autoRecover: 0.5, viewKickZ: 0.028, viewKickRotDeg: 1.5, shake: 0.18 },
    sound: { shot: 'gun_pistol', rate: 1.18, mech: 'rifle' },
    model: { key: 'mp5', muzzle: 'SOCKET_FX_FIRE', casing: 'SOCKET_FX_CASING', mag: 'MAGASINE', bolt: 'BOLT', sight: 'SOCKET_IRONSIGHT', rear: 'SOCKET_ATTACH_SCOPE', eye: [0, 0.176, -0.001] },
  },
  m700: {
    name: 'M700', class: 'sniper', ammo: 'sniper', mode: 'bolt', rpm: 50, mag: 5, boltTime: 1.1,
    damage: [{ d: 0, dmg: 130 }, { d: 150, dmg: 110 }], head: 2.4, limb: 0.9, range: 900,
    reload: 3.0, reloadEmpty: 3.5, reloadCues: { magout: 0.18, magin: 0.6, charge: 0.86 },
    ads: 0.48, sprintToFire: 0.38, raise: 0.8, mobility: 0.92, adsFovMult: 0.25, scope: true, scopeSwayDeg: 0.35, holdBreath: 4.0,
    spread: { hip: 7.0, move: 3.0, ads: 0.0, bloom: 0, max: 7, recover: 10, air: 8 },
    recoil: { vKick: 4.5, vRamp: 0, rampShots: 1, hKick: 0, hFreq: 0, hBias: 0, hJitter: 0.6, firstShot: 1, hipMult: 1.2, recover: 6, autoRecover: 0.85, viewKickZ: 0.09, viewKickRotDeg: 7, shake: 0.8 },
    sound: { shot: 'gun_sniper', rate: 1.0, mech: 'bolt' },
    model: { key: 'm700', muzzle: 'SOCKET_FX_FIRE', casing: 'SOCKET_FX_CASING', mag: 'MAGAZINE', bolt: 'BOLT', sight: 'SOCKET_IRONSIGHT', rear: 'SOCKET_ATTACH_SCOPE', eye: [0, 0.097, 0.06],
      scope: { key: 'sniper_scope', node: 'Scope', mount: 'SOCKET_ATTACH_SCOPE', offset: [0.006, 0.0, 0.02] } },
  },
  m1911: {
    name: '1911', class: 'pistol', ammo: 'light', mode: 'semi', rpm: 400, mag: 8,
    damage: [{ d: 0, dmg: 42 }, { d: 12, dmg: 34 }, { d: 25, dmg: 26 }], head: 1.6, limb: 0.9, range: 120,
    reload: 1.55, reloadEmpty: 1.9, reloadCues: { magout: 0.12, magin: 0.55, charge: 0.85 },
    ads: 0.16, sprintToFire: 0.12, raise: 0.35, mobility: 1.03, adsFovMult: 0.9,
    spread: { hip: 2.6, move: 1.0, ads: 0.2, bloom: 0.6, max: 5, recover: 10, air: 3 },
    recoil: { vKick: 1.6, vRamp: 0, rampShots: 1, hKick: 0, hFreq: 0, hBias: 0, hJitter: 0.3, firstShot: 1, hipMult: 1.1, recover: 9, autoRecover: 0.7, viewKickZ: 0.05, viewKickRotDeg: 5, shake: 0.3 },
    sound: { shot: 'gun_pistol', rate: 0.92, mech: 'pistol' },
    model: { key: 'm1911', muzzle: 'SOCKET_FX_FIRE', casing: 'SOCKET_FX_CASING', mag: 'MAGAZINE', bolt: 'SLIDE', sight: 'SOCKET_IRONSIGHT', rear: 'SOCKET_ATTACH_SCOPE', eye: [0, 0.088, 0.2] },
  },
  frag: {
    name: 'FRAG', class: 'lethal', fuse: 4.0, throwSpeed: 19, upBoost: 3.5, gravity: 9.81, restitution: 0.38, friction: 0.6,
    damageMax: 160, damageMin: 12, innerRadius: 2.0, outerRadius: 8.0, maxCarry: 2, throwTime: 0.55, selfDamage: true,
    shakeRadius: 25,
    model: { key: 'frag', pin: 'Pin' },
  },
});

// ---------------------------------------------------------------- match flow
export const MATCH = Object.freeze({
  maxPlayers: 10,             // humans + bots: bots fill every empty slot up to this
  maxHumans: 10,
  minHumansToCountdown: 2,
  lobbyCountdown: 45,         // s, once >= 2 humans
  lobbyCountdownFull: 10,     // s, once >= 6 humans
  aloneStartAfter: 20,        // quick play: start vs bots if still alone after this many s
  startLeadMs: 4000,          // 'start' message is sent this long before plane launch
  plane: { altitude: 380, speed: 55, preDistance: 900, postDistance: 900, doorsOpenRadius: 520, forceJumpAt: 420, centerJitter: 150 },
  endDelay: 6,                // s between the last kill and the results screen
});

// Zone: phases begin at startAt (match time, s). Each phase waits, then shrinks to r.
// Next centre: uniformly inside (prevR - nextR) of the previous centre, retried until on land.
export const ZONE = Object.freeze({
  initial: { x: 0, z: 0, r: 860 },
  startAt: 60,
  phases: [
    { wait: 70, shrink: 60, r: 400, dps: 2 },
    { wait: 55, shrink: 45, r: 220, dps: 4 },
    { wait: 45, shrink: 40, r: 115, dps: 7 },
    { wait: 35, shrink: 30, r: 55, dps: 10 },
    { wait: 30, shrink: 25, r: 22, dps: 14 },
    { wait: 20, shrink: 20, r: 0, dps: 20 },
  ],
  landRetries: 12,
  wallHeight: 320,
  ignoresArmor: true,
});

// ---------------------------------------------------------------- loot
export const LOOT = Object.freeze({
  floorChance: [0.6, 0.75, 0.9],         // by spawn tier 0/1/2
  crateItems: 3,
  kinds: [                                // weights per tier [t0, t1, t2]
    { type: 'weapon', w: [30, 35, 45] },
    { type: 'ammo', w: [35, 30, 20] },
    { type: 'plate', w: [25, 25, 25] },
    { type: 'frag', w: [10, 10, 10] },
  ],
  weapons: {                              // weights per tier [t0, t1, t2]
    m1911: [35, 15, 0], mp5: [35, 30, 15], ak47: [15, 25, 30], m4a1: [15, 25, 35], m700: [0, 5, 20],
  },
  ammoTypes: { ar: 45, light: 40, sniper: 15 },  // weights for loose ammo items
  ammoQty: { ar: 60, light: 60, sniper: 10 },
  plateQty: [1, 1, 2],
  fragQty: 1,
  weaponSpawnsAmmo: true,                 // a weapon item also spawns one ammo item of its type beside it
  dropScatter: 1.2,                       // m radius for death drops
  pickConflictMs: 600,                    // window in which an earlier remote claim wins
});

// ---------------------------------------------------------------- bots (run on the host)
export const BOTS = Object.freeze({
  names: ['Viper', 'Ghost', 'Nomad', 'Kestrel', 'Rook', 'Havoc', 'Mako', 'Saber', 'Draven', 'Onyx', 'Talon', 'Jinx',
    'Brick', 'Rafter', 'Cinder', 'Wolfe', 'Stitch', 'Ranger', 'Vex', 'Hollis', 'Quill', 'Banshee', 'Atlas', 'Mercer',
    'Kodiak', 'Sparrow', 'Fang', 'Halden', 'Rocco', 'Tundra', 'Wren', 'Grimm'],
  reaction: [0.35, 0.75],                 // s from first sight to first shot
  aimErrorDeg: { start: 4.5, min: 0.9, settle: 1.6 },
  burstShots: [3, 8], burstPause: [0.25, 0.7],
  viewDistance: 140, fovDeg: 120, hearing: 60,
  engageRange: { m1911: 30, mp5: 45, ak47: 90, m4a1: 100, m700: 220 },
  headshotChance: 0.12,
  thinkHz: 10,
  lootTime: [35, 80],
  fallbackWeaponAfter: 60,                // s without a primary -> grant a tier-1 weapon
});

// ---------------------------------------------------------------- networking (Trystero Nostr, see ARCHITECTURE.md section 8)
export const NET = Object.freeze({
  appId: 'zonefall-v1',
  protocol: 1,
  relays: ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.mom',
    'wss://relay.nostr.net', 'wss://nostr.oxtr.dev', 'wss://relay.piazza.today', 'wss://nostr.rblb.it'],
  turn: [],                               // [{urls, username, credential}] when a TURN account exists
  snapRate: 20, lobbySnapRate: 5, botRate: 15,
  interpDelay: 100, interpMin: 80, interpMax: 200,
  staleMs: 3000, dropMs: 10000,
  maxMsgsPerSec: 80,
  quickPrefix: 'zf1-qp', privatePrefix: 'zf1-pv', buckets: 30, bucketProbeMs: 3500,
  codeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', codeLength: 5,
  relayTimeoutMs: 8000,
  channelId: 42,
  bufferedLimit: 16384,
  maxReceiveBytes: 1000000,
  historyMs: 1000,                        // own pose history kept for hit validation
});

// ---------------------------------------------------------------- input (KeyboardEvent.code; Mouse0/1/2 buttons; WheelUp/WheelDown)
export const BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['KeyC', 'ControlLeft'], sprint: ['ShiftLeft'],
  fire: ['Mouse0'], ads: ['Mouse2'], reload: ['KeyR'], interact: ['KeyF'], plate: ['Digit4'], grenade: ['KeyG'],
  slot1: ['Digit1'], slot2: ['Digit2'], swap: ['WheelUp', 'WheelDown'],
  map: ['KeyM'], scoreboard: ['Tab'], pause: ['Escape', 'KeyP'], freelook: ['AltLeft'],
});
export const ACTION_LABELS = Object.freeze({
  forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right', jump: 'Jump / Deploy',
  crouch: 'Crouch / Slide', sprint: 'Sprint / Hold breath', fire: 'Fire', ads: 'Aim down sights', reload: 'Reload',
  interact: 'Interact / Pick up', plate: 'Armor plate', grenade: 'Frag grenade', slot1: 'Weapon 1', slot2: 'Weapon 2',
  swap: 'Switch weapon', map: 'Map', scoreboard: 'Players', pause: 'Menu', freelook: 'Free look',
});

// ---------------------------------------------------------------- settings (persisted by core/settings.js)
export const SETTINGS_DEFAULTS = Object.freeze({
  name: '',
  sensitivity: 1.0,          // x PLAYER.mouseRadPerPx
  adsSensitivity: 0.85,
  fov: 95,                   // horizontal degrees at 16:9 (camera converts to vertical)
  invertY: false,
  quality: 'auto',           // 'auto' | 'low' | 'medium' | 'high'
  masterVolume: 0.8, sfxVolume: 1.0, uiVolume: 0.7, ambienceVolume: 0.6,
  showFps: false,
  muted: false,
});
export const SETTINGS_LIMITS = Object.freeze({
  sensitivity: [0.1, 4], adsSensitivity: [0.3, 1.5], fov: [80, 110],
  masterVolume: [0, 1], sfxVolume: [0, 1], uiVolume: [0, 1], ambienceVolume: [0, 1],
});

// ---------------------------------------------------------------- appearance
export const TEAM_TINTS = Object.freeze([0xffffff, 0x9aa27a, 0xc9b48a, 0x8f9aa6, 0xa39783, 0x7f8c6e]); // by slot % length

// ---------------------------------------------------------------- skins and shop
// Character skins (assets/skins/<id>.glb, built by tools/build-skins.mjs). 'soldier' is the default outfit (the
// soldier_a/soldier_b models with team tints) and is always owned. Skins load on demand the first time an entity
// wearing one appears; until then that entity is drawn as a soldier.
export const SKIN_DEFAULT = 'soldier';
export const RARITY = Object.freeze({       // colours: --zf-r-* in src/ui/styles.css
  rare: { label: 'Rare' },
  epic: { label: 'Epic' },
  legendary: { label: 'Legendary' },
});
// All outfits are free for now (price 0 = owned by every profile); set a price to sell one in the shop again.
export const SKINS = Object.freeze({
  soldier: { name: 'Operator', rarity: null, price: 0 },
  jonesy: { name: 'Jonesy', rarity: 'rare', price: 0 },
  rigby: { name: 'Rigby', rarity: 'rare', price: 0 },
  lizard: { name: 'Tom Lizard', rarity: 'rare', price: 0 },
  huggy: { name: 'Huggy Wuggy', rarity: 'epic', price: 0 },
  banana: { name: 'Banana', rarity: 'epic', price: 0 },
  daffy: { name: 'Daffy Duck', rarity: 'epic', price: 0 },
  bandit: { name: 'Psycho Bandit', rarity: 'epic', price: 0 },
  stormtrooper: { name: 'Stormtrooper', rarity: 'legendary', price: 0 },
  deadpool: { name: 'Deadpool', rarity: 'legendary', price: 0 },
  drake: { name: 'Sgt. Drake', rarity: 'legendary', price: 0 },
  spongebob: { name: 'SpongeBob', rarity: 'legendary', price: 0 },
});
export const skinUrl = (id) => assetUrl(`skins/${id}.glb`);
export const isSkin = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SKINS, id);

export const ECONOMY = Object.freeze({
  startCoins: 1000,      // a new profile can buy one rare skin straight away
  shopRotation: 4,       // skins in the daily featured row (seeded by the date)
  botSkinChance: 0.8,    // share of bots that wear a skin instead of the soldier outfit
});
