// ZONEFALL - the island "Kessler Isle": fixed layout shared by WORLD (builds it), GAME (loot, zone, bots, plane)
// and UI (map labels). OWNER: LEAD. Complete. Coordinates are world metres: +X east, -Z north, Y up, sea level y = 0.
// The layout never changes between matches (MAP.seed is constant); per-match variety comes from the match seed.

export const MAP = Object.freeze({
  name: 'KESSLER ISLE',
  seed: 1337,             // terrain, foliage, building and loot-spawn-point generation
  size: 1200,             // square world, x and z in [-600, 600]
  half: 600,
  seaLevel: 0,
  // Default coastline: r(theta) = coastBase + 28 sin(3 theta + 0.9) + 14 sin(7 theta + 2.3), theta = atan2(z, x).
  // POI discs, landmark discs and roads always win: terrain inside them is land (see ARCHITECTURE.md 3.2).
  coastBase: 478,
  beachWidth: 24,         // sand band from the waterline inland
  seabed: -12,            // terrain height far offshore
  naturalHeight: [6, 34], // rolling hills on land outside POIs (fbm)
  maxHeight: 75,
  harbor: { x0: -20, x1: 140, z: 455 }, // Southport quay: straight concrete quay wall along z = 455, deep water south of it
});

/**
 * Named points of interest. r = radius of the flattened site (terrain = h inside 0.8 r, blended to natural terrain by r).
 * tier = loot tier of spawns inside (0 common, 1 standard, 2 high). lootPoints = target count of floor spawn points.
 * crates = military crates (each holds LOOT.crateItems items of tier min(tier + 1, 2)). buildings = the build programme.
 */
export const POIS = Object.freeze([
  {
    id: 'harrow', name: 'HARROW', type: 'town', x: -40, z: 40, r: 120, h: 14, tier: 1, lootPoints: 120, crates: 3,
    buildings: [{ kind: 'house', count: 12 }, { kind: 'shop', count: 4 }, { kind: 'church', count: 1 }],
    notes: 'Market town on the main crossroads. Main street runs E-W along road R2, two cross streets, a central square. ' +
      'Houses are two storeys with stairs; shops one storey with large windows; church nave plus bell tower.',
  },
  {
    id: 'millbrook', name: 'MILLBROOK FARM', type: 'farm', x: -330, z: 150, r: 85, h: 10, tier: 1, lootPoints: 40, crates: 2,
    buildings: [{ kind: 'farmhouse', count: 1 }, { kind: 'barn', count: 1 }, { kind: 'shed', count: 2 }, { kind: 'silo', count: 2 }],
    notes: 'Barn (12 x 20 m, hayloft upper floor), two-storey farmhouse, corrugated sheds, two silos (solid). Fenced crop fields around.',
  },
  {
    id: 'kessler', name: 'FORT KESSLER', type: 'military', x: 250, z: -250, r: 125, h: 22, tier: 2, lootPoints: 70, crates: 8,
    wall: { x0: 160, x1: 340, z0: -330, z1: -170, gates: [[230, -170], [340, -250]] },
    buildings: [{ kind: 'barracks', count: 3 }, { kind: 'hangar', count: 1 }, { kind: 'command', count: 1 }, { kind: 'watchtower', count: 4 }, { kind: 'containers', count: 6 }],
    notes: 'Walled base: concrete barrier perimeter with two gates, barracks, an open-front hangar, two-storey command post with a flat roof, ' +
      'four watchtowers at the corners, helipad, container stacks. Highest loot tier.',
  },
  {
    id: 'greystone', name: 'GREYSTONE QUARRY', type: 'quarry', x: 320, z: 190, r: 100, h: 26, pitFloor: 6, pitRadius: 62, tier: 1, lootPoints: 40, crates: 2,
    buildings: [{ kind: 'site_office', count: 1 }, { kind: 'shed', count: 2 }, { kind: 'conveyor', count: 1 }],
    notes: 'Open pit carved into the plateau: terraces of ~6 m down to pitFloor, a ramp road spiralling in, gravel piles, rocks, conveyor gantry, site office on the rim.',
  },
  {
    id: 'signal', name: 'SIGNAL HILL', type: 'radio', x: -250, z: -300, r: 70, h: 62, tier: 1, lootPoints: 25, crates: 2,
    buildings: [{ kind: 'radio_tower', count: 1 }, { kind: 'equipment_shed', count: 1 }, { kind: 'bunker', count: 1 }],
    notes: 'Hilltop with a 55 m lattice radio mast (visible from everywhere, red aviation lights), concrete equipment shed, half-buried bunker with an interior. Switchback road up.',
  },
  {
    id: 'southport', name: 'SOUTHPORT YARD', type: 'industrial', x: 60, z: 380, r: 100, h: 4, tier: 1, lootPoints: 70, crates: 4,
    buildings: [{ kind: 'warehouse', count: 3 }, { kind: 'office', count: 1 }, { kind: 'containers', count: 10 }, { kind: 'fuel_tank', count: 2 }, { kind: 'gantry_crane', count: 1 }, { kind: 'pier', count: 1 }],
    notes: 'Harbour yard on the south coast: corrugated warehouses (one with a mezzanine), two-storey office, stacked shipping containers, fuel tanks, a gantry crane and a timber pier running south from the quay into the sea.',
  },
  {
    id: 'pinecrest', name: 'PINECREST', type: 'village', x: 20, z: -255, r: 90, h: 16, tier: 1, lootPoints: 70, crates: 2,
    buildings: [{ kind: 'house', count: 9 }, { kind: 'shop', count: 2 }],
    notes: 'Hillside village in the north on road R10, between the two northern forests: houses with yards along the road, a general store and a cafe, a small green.',
  },
  {
    id: 'timber', name: 'TIMBER MILL', type: 'lumber', x: -215, z: -45, r: 70, h: 18, tier: 1, lootPoints: 40, crates: 2,
    buildings: [{ kind: 'warehouse', count: 1 }, { kind: 'shed', count: 2 }, { kind: 'cabin', count: 3 }],
    notes: 'Sawmill on the western track R11 at the edge of the big forest: an open saw hall, two sheds, worker cabins, log stacks and a container yard as cover.',
  },
  {
    id: 'motel', name: 'SUNSET MOTEL', type: 'motel', x: 265, z: -40, r: 62, h: 20, tier: 1, lootPoints: 36, crates: 1,
    buildings: [{ kind: 'cabin', count: 6 }, { kind: 'shop', count: 1 }],
    notes: 'Roadside motel on R12 east of Mile 9: an L of six room cabins around a parking lot, a diner by the road, parked cars.',
  },
  {
    id: 'city', name: 'DOWNTOWN', type: 'city', x: -160, z: 290, r: 96, h: 16, tier: 2, lootPoints: 60, crates: 3,
    // the Procedural City 3 block (assets/props/city/city.glb, 0.85 scale, street plane at local y = 0): the terrain
    // is held at h across the pad and blends into the hills over `blend` metres (heightfield rectFlatten)
    pad: { w: 131.27, d: 140.06, blend: 34 },
    blocks: [[-27.75, 25.88, -23.43, 53.04, 20.43], [-48.59, -52.97, -32.44, -42.15, 20.43], [-48.59, -0.56, -27.29, 25.92, 28.08], [-9.57, -0.56, 4.96, 52.97, 28.08], [26.21, -0.56, 48.59, 52.97, 28.09], [26.21, -52.97, 48.59, -21.83, 17.89]],           // building footprints [x0, z0, x1, z1, height], city-local (city.json)
    buildings: [],
    notes: 'A block of brick apartment towers and offices on a street grid in the south-west hills: solid buildings, parked cars and street furniture as cover, high-tier loot in the streets.',
  },
]);

/** Minor sites (named on the big map in small type). tier 0 unless noted. */
export const LANDMARKS = Object.freeze([
  { id: 'fuel', name: 'MILE 9 FUEL', type: 'fuel_station', x: 150, z: 10, r: 30, h: 16, tier: 0, lootPoints: 10, crates: 1, buildings: [{ kind: 'fuel_canopy', count: 1 }, { kind: 'shop', count: 1 }] },
  { id: 'lighthouse', name: 'CAPE LIGHT', type: 'lighthouse', x: 415, z: -30, r: 28, h: 18, tier: 0, lootPoints: 8, crates: 1, buildings: [{ kind: 'lighthouse', count: 1 }, { kind: 'cabin', count: 1 }] },
  { id: 'bunker', name: 'NORTH BUNKER', type: 'bunker', x: -395, z: -70, r: 30, h: 16, tier: 1, lootPoints: 10, crates: 1, buildings: [{ kind: 'bunker', count: 1 }] },
]);

/** Roadside houses scattered along roads (tier 0), placed by WORLD with the map seed, at least 60 m from any POI centre. */
export const ROADSIDE = Object.freeze({ houses: 26, lootPointsEach: 4 });

/**
 * Road network: polylines of [x, z] points. 'asphalt' roads are 8 m wide, 'dirt' tracks 5 m.
 * Terrain is flattened across the road width plus 3 m shoulders. Surfaces: ASPHALT / DIRT.
 */
export const ROADS = Object.freeze([
  { id: 'R1', type: 'asphalt', pts: [[60, 430], [60, 330], [30, 200], [-40, 40], [-70, -80], [-160, -200]] },
  { id: 'R2', type: 'asphalt', pts: [[-330, 150], [-200, 105], [-40, 40], [100, 15], [150, 10], [240, 80], [300, 150]] },
  { id: 'R3', type: 'asphalt', pts: [[-40, 40], [60, -60], [170, -130], [230, -170]] },
  { id: 'R4', type: 'asphalt', pts: [[340, -250], [390, -150], [385, 0], [350, 110]] },
  { id: 'R5', type: 'dirt', pts: [[110, 370], [220, 300], [280, 250]] },
  { id: 'R6', type: 'dirt', pts: [[-330, 150], [-400, 40], [-395, -70], [-360, -190], [-300, -270]] },
  { id: 'R7', type: 'dirt', pts: [[-160, -200], [-200, -215], [-185, -245], [-225, -262], [-250, -290]] },
  { id: 'R8', type: 'asphalt', pts: [[-200, 105], [-204, 170], [-195, 228]] },
  { id: 'R9', type: 'dirt', pts: [[385, 0], [415, -30]] },
  { id: 'R10', type: 'asphalt', pts: [[60, -60], [50, -150], [22, -250], [-50, -300], [-160, -200]] },
  { id: 'R11', type: 'dirt', pts: [[-70, -80], [-140, -62], [-215, -45], [-300, -32], [-397, -25]] },
  { id: 'R12', type: 'asphalt', pts: [[128, 12], [200, -22], [265, -48], [330, -38], [385, 0]] },
]);
export const ROAD_WIDTH = Object.freeze({ asphalt: 8, dirt: 5 });

/** Forest regions (dense trees, WORLD scatters with the map seed); elsewhere trees are sparse. Discs [x, z, r]. */
export const FORESTS = Object.freeze([
  [-300, -150, 120], [-120, -330, 110], [-420, 250, 80], [120, -380, 90], [200, 170, 70], [-70, 190, 45], [430, 120, 60],
  [-300, 250, 42], [330, 60, 45], [110, -190, 40], [-140, 150, 30],
]);

/**
 * Inland water at sea level (the ocean surface covers it, so swimming, splashes and the water plane need nothing
 * extra): a lake south of Harrow in a carved basin, and a river valley winding from it to the south-west coast.
 * river = centreline [x, z] from the lake to past the shore; width grows from w0 at the lake to w1 at the mouth.
 */
export const WATERWAYS = Object.freeze({
  lake: { x: -28, z: 252, r: 31 },
  river: { w0: 9, w1: 16, pts: [[-28, 252], [-42, 305], [-62, 362], [-102, 412], [-160, 444], [-214, 472], [-262, 508]] },
});

export const ALL_SITES = Object.freeze([...POIS, ...LANDMARKS]);
export const siteById = (id) => ALL_SITES.find((s) => s.id === id) || null;

/** The site whose disc contains (x, z), or null. */
export function siteAt(x, z) {
  let best = null, bd = Infinity;
  for (const s of ALL_SITES) {
    const d = Math.hypot(x - s.x, z - s.z);
    if (d <= s.r && d < bd) { best = s; bd = d; }
  }
  return best;
}
