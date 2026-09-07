// js/data/buildings.js — the 16 base buildings, their costs, timings and effects.
// PURE DATA + pure helpers. Imports only ./balance.js.
// Exports: BUILDINGS, BUILDING_KEYS, BUILDING_CATEGORIES, PRODUCER_KEYS, MAX_LEVEL,
//          getBuilding, getCost, getBuildTime, getProduction, getCapacity, getEffect,
//          requirementsMet, missingRequirements, buildingsByCategory,
//          maxCopies, countBuilt, getPlaceCost, copyLimitText

import {
  MAX_LEVEL, costAt, timeAt, prodAt, scaleCost, scaleAt
} from './balance.js';

export { MAX_LEVEL };

/** Display groups used by the base screen filter chips. */
export const BUILDING_CATEGORIES = ['core', 'economy', 'military', 'support'];

/**
 * BUILDINGS[key] = {
 *   key, name, desc, category, maxLevel, icon,
 *   cost:{oil,steel,rare,food}, costMult,      // level-1 cost, geometric per level
 *   buildTime, timeMult,                        // level-1 seconds, geometric
 *   requires:{ hq?:number, <buildingKey>?:number },
 *   produces?:{ res, perHour, mult },           // per-hour output at level 1
 *   capacity?:{ res:'all'|<resKey>, base, mult, protectedBase?, protectedMult? },
 *   unique:boolean,                             // only one may exist on the plot grid
 *   maxCopies?(hqLevel) -> number,              // non-unique cap on simultaneous copies
 *   copyCostMult?:number,                       // each extra copy costs this much more
 *   effect(level) -> { <effectKey>: number }    // extra derived effects
 * }
 *
 * effect() keys used across the game:
 *   'queue.build'      extra concurrent construction slots
 *   'queue.train'      extra concurrent training slots
 *   'queue.research'   extra concurrent research slots
 *   'train.speed'      % faster unit training (0.05 = +5%)
 *   'build.speed'      % faster construction
 *   'research.speed'   % faster research
 *   'heal.capacity'    wounded-unit beds
 *   'heal.speed'       % faster healing
 *   'march.slots'      simultaneous marches allowed
 *   'march.speed'      % faster marches
 *   'map.vision'       world-map reveal radius in tiles
 *   'wall.hp'          garrison wall hit points
 *   'wall.defense'     % defence bonus for units defending the base
 *   'officer.slots'    officers assignable at once
 *   'officer.xpRate'   % faster officer XP
 *   'trade.rate'       resource exchange efficiency (0..1)
 *   'trade.gold'       gold produced per hour
 *   'unlock.tier'      highest unit tier the factory can build (see units.js)
 */
export const BUILDINGS = {
  // ------------------------------------------------------------------ core
  hq: {
    key: 'hq',
    name: 'Headquarters',
    desc: 'Command centre. Its level caps every other building and unlocks new facilities.',
    category: 'core',
    maxLevel: MAX_LEVEL,
    icon: 'bld_hq',
    unique: true,
    cost: { oil: 900, steel: 900, rare: 60, food: 600 },
    costMult: 1.33,
    buildTime: 90,
    timeMult: 1.3,
    requires: {},
    capacity: { res: 'all', base: 20000, mult: 1.2 },
    effect: (l) => ({
      'build.speed': 0.01 * (l - 1),
      'march.slots': 1 + Math.floor(l / 8),
      'officer.slots': 1 + Math.floor(l / 10)
    })
  },

  // --------------------------------------------------------------- economy
  oil_well: {
    key: 'oil_well',
    name: 'Oil Derrick',
    desc: 'Pumps crude oil, the fuel of every vehicle and aircraft in the field.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_oil_well',
    unique: false,
    // Producers are the one thing you could otherwise carpet the plot grid with.
    // Copies are capped by HQ level and every extra copy costs more, so past the
    // second or third derrick UPGRADING is the cheaper way to add output.
    maxCopies: (hq) => 1 + Math.floor(hq / 5),
    copyCostMult: 2.6,
    cost: { oil: 60, steel: 220, rare: 0, food: 120 },
    costMult: 1.3,
    buildTime: 45,
    timeMult: 1.28,
    requires: { hq: 1 },
    produces: { res: 'oil', perHour: 120, mult: 1.22 },
    effect: () => ({})
  },
  steel_mill: {
    key: 'steel_mill',
    name: 'Steel Mill',
    desc: 'Smelts ore into the plate and structural steel every build order consumes.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_steel_mill',
    unique: false,
    // Producers are the one thing you could otherwise carpet the plot grid with.
    // Copies are capped by HQ level and every extra copy costs more, so past the
    // second or third derrick UPGRADING is the cheaper way to add output.
    maxCopies: (hq) => 1 + Math.floor(hq / 5),
    copyCostMult: 2.6,
    cost: { oil: 220, steel: 60, rare: 0, food: 120 },
    costMult: 1.3,
    buildTime: 45,
    timeMult: 1.28,
    requires: { hq: 1 },
    produces: { res: 'steel', perHour: 110, mult: 1.22 },
    effect: () => ({})
  },
  rare_mine: {
    key: 'rare_mine',
    name: 'Rare Earth Mine',
    desc: 'Extracts the rare earths needed for electronics, avionics and advanced research.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_rare_mine',
    unique: false,
    // Producers are the one thing you could otherwise carpet the plot grid with.
    // Copies are capped by HQ level and every extra copy costs more, so past the
    // second or third derrick UPGRADING is the cheaper way to add output.
    maxCopies: (hq) => 1 + Math.floor(hq / 5),
    copyCostMult: 2.6,
    cost: { oil: 400, steel: 400, rare: 0, food: 200 },
    costMult: 1.31,
    buildTime: 120,
    timeMult: 1.29,
    requires: { hq: 4 },
    produces: { res: 'rare', perHour: 42, mult: 1.22 },
    effect: () => ({})
  },
  farm: {
    key: 'farm',
    name: 'Collective Farm',
    desc: 'Grows the rations that keep your standing army from starving.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_farm',
    unique: false,
    // Producers are the one thing you could otherwise carpet the plot grid with.
    // Copies are capped by HQ level and every extra copy costs more, so past the
    // second or third derrick UPGRADING is the cheaper way to add output.
    maxCopies: (hq) => 1 + Math.floor(hq / 5),
    copyCostMult: 2.6,
    cost: { oil: 120, steel: 180, rare: 0, food: 40 },
    costMult: 1.29,
    buildTime: 40,
    timeMult: 1.27,
    requires: { hq: 1 },
    produces: { res: 'food', perHour: 150, mult: 1.22 },
    effect: () => ({})
  },
  warehouse: {
    key: 'warehouse',
    name: 'Warehouse',
    desc: 'Raises storage caps and shields a slice of every resource from raiders.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_warehouse',
    unique: true,
    cost: { oil: 300, steel: 300, rare: 0, food: 150 },
    costMult: 1.3,
    buildTime: 70,
    timeMult: 1.28,
    requires: { hq: 1 },
    capacity: {
      res: 'all',
      base: 30000,
      mult: 1.28,
      protectedBase: 4000,
      protectedMult: 1.26
    },
    effect: () => ({})
  },
  trade_center: {
    key: 'trade_center',
    name: 'Trade Centre',
    desc: 'Exchanges surplus resources and skims a steady trickle of gold from convoys.',
    category: 'economy',
    maxLevel: MAX_LEVEL,
    icon: 'bld_trade_center',
    unique: true,
    cost: { oil: 5200, steel: 5200, rare: 900, food: 3200 },
    costMult: 1.31,
    buildTime: 900,
    timeMult: 1.28,
    requires: { hq: 12, warehouse: 10 },
    effect: (l) => ({
      'trade.rate': Math.min(0.95, 0.5 + 0.015 * (l - 1)),
      'trade.gold': Math.round(scaleAt(4, 1.12, l))
    })
  },

  // -------------------------------------------------------------- military
  barracks: {
    key: 'barracks',
    name: 'Barracks',
    desc: 'Trains infantry. Its level gates which infantry tiers you may field.',
    category: 'military',
    maxLevel: MAX_LEVEL,
    icon: 'bld_barracks',
    unique: true,
    cost: { oil: 260, steel: 380, rare: 0, food: 260 },
    costMult: 1.3,
    buildTime: 90,
    timeMult: 1.28,
    requires: { hq: 2 },
    effect: (l) => ({
      'train.speed': 0.015 * (l - 1),
      'unlock.tier': tierForFactory(l)
    })
  },
  tank_factory: {
    key: 'tank_factory',
    name: 'Tank Factory',
    desc: 'Assembly line for armour. Its level gates which tank tiers you may field.',
    category: 'military',
    maxLevel: MAX_LEVEL,
    icon: 'bld_tank_factory',
    unique: true,
    cost: { oil: 1400, steel: 1900, rare: 120, food: 600 },
    costMult: 1.31,
    buildTime: 260,
    timeMult: 1.29,
    requires: { hq: 5, barracks: 4 },
    effect: (l) => ({
      'train.speed': 0.015 * (l - 1),
      'unlock.tier': tierForFactory(l)
    })
  },
  hangar: {
    key: 'hangar',
    name: 'Aircraft Hangar',
    desc: 'Builds and services aircraft. Its level gates which air tiers you may field.',
    category: 'military',
    maxLevel: MAX_LEVEL,
    icon: 'bld_hangar',
    unique: true,
    cost: { oil: 3600, steel: 3000, rare: 500, food: 1200 },
    costMult: 1.31,
    buildTime: 620,
    timeMult: 1.29,
    requires: { hq: 9, tank_factory: 5 },
    effect: (l) => ({
      'train.speed': 0.015 * (l - 1),
      'unlock.tier': tierForFactory(l)
    })
  },
  artillery_range: {
    key: 'artillery_range',
    name: 'Artillery Range',
    desc: 'Calibrates guns and rocket batteries. Gates which artillery tiers you may field.',
    category: 'military',
    maxLevel: MAX_LEVEL,
    icon: 'bld_artillery_range',
    unique: true,
    cost: { oil: 5400, steel: 6400, rare: 800, food: 1800 },
    costMult: 1.31,
    buildTime: 900,
    timeMult: 1.29,
    requires: { hq: 13, tank_factory: 8 },
    effect: (l) => ({
      'train.speed': 0.015 * (l - 1),
      'unlock.tier': tierForFactory(l)
    })
  },
  wall: {
    key: 'wall',
    name: 'Perimeter Wall',
    desc: 'Fortifies the base. Its hit points soak enemy fire and its defence bonus '
      + 'applies to every unit at home when a raid reaches your city.',
    category: 'military',
    maxLevel: MAX_LEVEL,
    icon: 'bld_wall',
    unique: true,
    cost: { oil: 200, steel: 600, rare: 0, food: 100 },
    costMult: 1.3,
    buildTime: 80,
    timeMult: 1.28,
    requires: { hq: 2 },
    effect: (l) => ({
      'wall.hp': Math.round(scaleAt(2000, 1.26, l)),
      'wall.defense': 0.02 * l
    })
  },

  // --------------------------------------------------------------- support
  lab: {
    key: 'lab',
    name: 'Research Lab',
    desc: 'Unlocks the tech tree. Every technology is capped by this building level.',
    category: 'support',
    maxLevel: MAX_LEVEL,
    icon: 'bld_lab',
    unique: true,
    cost: { oil: 500, steel: 500, rare: 80, food: 300 },
    costMult: 1.31,
    buildTime: 150,
    timeMult: 1.29,
    requires: { hq: 3 },
    effect: (l) => ({
      'research.speed': 0.02 * (l - 1)
    })
  },
  hospital: {
    key: 'hospital',
    name: 'Field Hospital',
    desc: 'Beds for wounded troops. Heal them back into service instead of losing them.',
    category: 'support',
    maxLevel: MAX_LEVEL,
    icon: 'bld_hospital',
    unique: true,
    cost: { oil: 700, steel: 700, rare: 60, food: 500 },
    costMult: 1.3,
    buildTime: 180,
    timeMult: 1.28,
    requires: { hq: 6, barracks: 5 },
    effect: (l) => ({
      'heal.capacity': Math.round(scaleAt(200, 1.24, l)),
      'heal.speed': 0.03 * (l - 1)
    })
  },
  academy: {
    key: 'academy',
    name: 'Officer Academy',
    desc: 'Recruits, levels and promotes commanders. Raises the officer XP rate.',
    category: 'support',
    maxLevel: MAX_LEVEL,
    icon: 'bld_academy',
    unique: true,
    cost: { oil: 1600, steel: 1600, rare: 260, food: 900 },
    costMult: 1.31,
    buildTime: 420,
    timeMult: 1.29,
    requires: { hq: 8, lab: 5 },
    effect: (l) => ({
      'officer.xpRate': 0.04 * (l - 1),
      'officer.slots': 1 + Math.floor(l / 6)
    })
  },
  radar: {
    key: 'radar',
    name: 'Radar Station',
    desc: 'Extends world-map vision, adds march slots and speeds every column up.',
    category: 'support',
    maxLevel: MAX_LEVEL,
    icon: 'bld_radar',
    unique: true,
    cost: { oil: 2400, steel: 2000, rare: 420, food: 800 },
    costMult: 1.31,
    buildTime: 520,
    timeMult: 1.29,
    requires: { hq: 10, lab: 6 },
    effect: (l) => ({
      'map.vision': 6 + Math.floor(l * 0.9),
      'march.slots': Math.floor((l + 4) / 7),
      'march.speed': 0.015 * (l - 1)
    })
  }
};

/**
 * Highest unit tier a level-`l` factory can produce: tier 1 at level 1,
 * a new tier every 3 levels, capped at tier 8 (level 22+).
 * Mirrored by FACTORY_LEVEL_FOR_TIER in js/data/units.js — keep both in step.
 * @param {number} l
 * @returns {number} 1..8
 */
export function tierForFactory(l) {
  const lv = Math.max(1, Math.floor(Number(l) || 1));
  return Math.max(1, Math.min(8, Math.floor((lv - 1) / 3) + 1));
}

/** Every building key, in a sensible menu order. */
export const BUILDING_KEYS = [
  'hq',
  'oil_well', 'steel_mill', 'rare_mine', 'farm', 'warehouse', 'trade_center',
  'barracks', 'tank_factory', 'hangar', 'artillery_range', 'wall',
  'lab', 'hospital', 'academy', 'radar'
];

/** Keys of the four resource producers, in RES_ORDER order. */
export const PRODUCER_KEYS = ['oil_well', 'steel_mill', 'rare_mine', 'farm'];

/** @param {string} key @returns {object|null} the definition (never a copy) */
export function getBuilding(key) {
  return BUILDINGS[key] || null;
}

/** All building defs in a category. */
export function buildingsByCategory(category) {
  return BUILDING_KEYS.map((k) => BUILDINGS[k]).filter((b) => b.category === category);
}

/**
 * Resource cost to reach `level` (i.e. the cost of the upgrade that produces it).
 * @param {string} key
 * @param {number} level target level, 1..maxLevel
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function getCost(key, level) {
  const b = BUILDINGS[key];
  if (!b) return {};
  return scaleCost(b.cost, b.costMult, level);
}

/**
 * How many copies of `key` may stand on the plot grid at once.
 * Unique buildings are always 1; producers scale with the HQ level; anything
 * else is unlimited (Infinity).
 * @param {string} key
 * @param {number} hqLevel
 * @returns {number} 1..Infinity
 */
export function maxCopies(key, hqLevel) {
  const b = BUILDINGS[key];
  if (!b) return 0;
  if (b.unique) return 1;
  const hq = Math.max(1, Math.floor(Number(hqLevel) || 1));
  if (typeof b.maxCopies === 'function') return Math.max(1, Math.floor(b.maxCopies(hq)));
  if (typeof b.maxCopies === 'number') return Math.max(1, Math.floor(b.maxCopies));
  return Infinity;
}

/**
 * How many copies of `key` already exist (buildings under construction count).
 * @param {string} key
 * @param {Array<{key:string}>} buildings S.buildings
 * @returns {number}
 */
export function countBuilt(key, buildings) {
  if (!Array.isArray(buildings)) return 0;
  let n = 0;
  for (let i = 0; i < buildings.length; i++) {
    if (buildings[i] && buildings[i].key === key) n += 1;
  }
  return n;
}

/**
 * Cost of PLACING a new copy. The first copy is the plain level-1 cost; every
 * further copy is multiplied by `copyCostMult` once per existing copy, so a
 * second derrick is affordable but a fourth is not the obvious play any more.
 * @param {string} key
 * @param {number} [existingCount=0]
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function getPlaceCost(key, existingCount) {
  const b = BUILDINGS[key];
  if (!b) return {};
  const base = getCost(key, 1);
  const n = Math.max(0, Math.floor(Number(existingCount) || 0));
  const mult = Number(b.copyCostMult) || 1;
  if (n === 0 || mult === 1) return base;
  const f = Math.pow(mult, n);
  const out = {};
  for (const k in base) {
    if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
    out[k] = Math.max(1, Math.round(base[k] * f));
  }
  return out;
}

/**
 * Human-readable copy limit, e.g. "2 / 3 built" — null when unlimited.
 * @param {string} key
 * @param {number} hqLevel
 * @param {Array} buildings
 * @returns {string|null}
 */
export function copyLimitText(key, hqLevel, buildings) {
  const max = maxCopies(key, hqLevel);
  if (!Number.isFinite(max) || max <= 1) return null;
  return countBuilt(key, buildings) + ' / ' + max + ' built';
}

/**
 * Base construction time in SECONDS to reach `level` (before build.speed bonuses).
 * @param {string} key
 * @param {number} level
 * @returns {number}
 */
export function getBuildTime(key, level) {
  const b = BUILDINGS[key];
  if (!b) return 0;
  return timeAt(b.buildTime, b.timeMult, level);
}

/**
 * Per-hour production of one building at `level`.
 * @param {string} key
 * @param {number} level
 * @returns {{res:string, perHour:number}|null} null for non-producers / level 0
 */
export function getProduction(key, level) {
  const b = BUILDINGS[key];
  if (!b || !b.produces || level < 1) return null;
  return {
    res: b.produces.res,
    perHour: prodAt(b.produces.perHour, b.produces.mult, level)
  };
}

/**
 * Storage capacity contributed by one building at `level`.
 * @param {string} key
 * @param {number} level
 * @returns {{oil:number,steel:number,rare:number,food:number,protected:number}}
 */
export function getCapacity(key, level) {
  const empty = { oil: 0, steel: 0, rare: 0, food: 0, protected: 0 };
  const b = BUILDINGS[key];
  if (!b || !b.capacity || level < 1) return empty;
  const c = b.capacity;
  const amount = Math.round(scaleAt(c.base, c.mult, level));
  const out = { oil: 0, steel: 0, rare: 0, food: 0, protected: 0 };
  if (c.res === 'all') {
    out.oil = amount;
    out.steel = amount;
    out.rare = amount;
    out.food = amount;
  } else if (c.res) {
    out[c.res] = amount;
  }
  if (c.protectedBase) {
    out.protected = Math.round(scaleAt(c.protectedBase, c.protectedMult || 1.2, level));
  }
  return out;
}

/**
 * Extra effects of one building at `level`.
 * @param {string} key
 * @param {number} level
 * @returns {Object<string,number>}
 */
export function getEffect(key, level) {
  const b = BUILDINGS[key];
  if (!b || typeof b.effect !== 'function' || level < 1) return {};
  return b.effect(Math.max(1, Math.floor(level))) || {};
}

/**
 * Are the prerequisites for building/upgrading `key` to `level` satisfied?
 * NOTE: the HQ gate ("every building level <= HQ level") is enforced here too.
 * @param {string} key
 * @param {number} level target level
 * @param {number} hqLevel current HQ level
 * @param {Object<string,number>|Array<{key:string,level:number}>} owned levels by building key
 * @returns {boolean}
 */
export function requirementsMet(key, level, hqLevel, owned) {
  return missingRequirements(key, level, hqLevel, owned).length === 0;
}

/**
 * Human-readable list of unmet prerequisites.
 * @param {string} key
 * @param {number} level target level
 * @param {number} hqLevel
 * @param {Object<string,number>|Array<{key:string,level:number}>} owned
 * @returns {{key:string,name:string,need:number,have:number}[]}
 */
export function missingRequirements(key, level, hqLevel, owned) {
  const b = BUILDINGS[key];
  const out = [];
  if (!b) return out;
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  const hq = Math.max(1, Math.floor(Number(hqLevel) || 1));
  const levels = normalizeLevels(owned);

  // HQ gate: nothing may exceed the HQ level (the HQ itself is exempt).
  if (key !== 'hq' && lv > hq) {
    out.push({ key: 'hq', name: BUILDINGS.hq.name, need: lv, have: hq });
  }
  const req = b.requires || {};
  for (const rk in req) {
    if (!Object.prototype.hasOwnProperty.call(req, rk)) continue;
    const need = Math.floor(req[rk]) || 0;
    const have = rk === 'hq' ? hq : (levels[rk] || 0);
    if (have < need) {
      const def = BUILDINGS[rk];
      out.push({ key: rk, name: def ? def.name : rk, need, have });
    }
  }
  return out;
}

/** Accept either a {key:level} map or an array of building records. */
function normalizeLevels(owned) {
  const out = {};
  if (!owned) return out;
  if (Array.isArray(owned)) {
    for (let i = 0; i < owned.length; i++) {
      const b = owned[i];
      if (!b || typeof b.key !== 'string') continue;
      const lv = Math.floor(Number(b.level) || 0);
      if (lv > (out[b.key] || 0)) out[b.key] = lv;
    }
    return out;
  }
  for (const k in owned) {
    if (!Object.prototype.hasOwnProperty.call(owned, k)) continue;
    out[k] = Math.floor(Number(owned[k]) || 0);
  }
  return out;
}
