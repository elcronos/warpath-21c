// js/data/units.js — 4 unit classes x 8 tiers = 32 units, plus the counter matrix.
// PURE DATA + pure helpers. Imports only ./balance.js, ./buildings.js, ./tech.js.
// Exports: UNITS, UNIT_KEYS, CLASSES, CLASS_META, COUNTER, COUNTER_LABEL,
//          FACTORY_LEVEL_FOR_TIER, DOCTRINE_LEVEL_FOR_TIER,
//          getUnit, unitsByClass, unitsOfTier, unitKey, counter, canTrain,
//          missingUnitRequirements, unitPower, trainCost, trainTime

import { scaleCost, costAt, timeAt, scaleAt } from './balance.js';
import { tierForFactory } from './buildings.js';
import { DOCTRINE_BY_CLASS, TECH } from './tech.js';

/** The four unit classes. */
export const CLASSES = ['infantry', 'tank', 'aircraft', 'artillery'];

/**
 * ===========================================================================
 * COUNTER TRIANGLE — read this before touching combat.
 * ===========================================================================
 * The three line classes form a closed rock-paper-scissors triangle:
 *
 *        TANK  ── beats ──▶  INFANTRY
 *          ▲                    │
 *          │                  beats
 *        beats                  │
 *          │                    ▼
 *       AIRCRAFT ◀── beats ── INFANTRY
 *
 *   • TANK beats INFANTRY      — armour rolls over foot troops.
 *   • INFANTRY beats AIRCRAFT  — man-portable AA shreds low passes.
 *   • AIRCRAFT beats TANK      — air-to-ground munitions gut armour from above.
 *
 * ARTILLERY is NOT part of the triangle. It is a support class:
 *   • It deals bonus damage to every class (1.15x) and extra against
 *     enemy artillery (1.3x) — counter-battery fire.
 *   • It ALWAYS fires last (COMBAT.artilleryPhase === 2), so it can be wiped
 *     out before it ever shoots.
 *   • It takes DOUBLE damage from every class (COMBAT.artilleryFragility === 2)
 *     on top of the 1.3x "vs artillery" column below — thin-skinned guns.
 *
 * COUNTER[attackerClass][defenderClass] = damage multiplier.
 * Advantage = 1.5, disadvantage = 0.7, neutral = 1.0.
 */
export const COUNTER = {
  infantry: { infantry: 1.0, tank: 0.7, aircraft: 1.5, artillery: 1.3 },
  tank: { infantry: 1.5, tank: 1.0, aircraft: 0.7, artillery: 1.3 },
  aircraft: { infantry: 0.7, tank: 1.5, aircraft: 1.0, artillery: 1.3 },
  artillery: { infantry: 1.15, tank: 1.15, aircraft: 1.15, artillery: 1.3 }
};

/** UI label for a counter multiplier. */
export function counterLabel(mult) {
  if (mult >= 1.4) return 'Strong';
  if (mult > 1) return 'Favoured';
  if (mult < 1) return 'Weak';
  return 'Even';
}
export const COUNTER_LABEL = counterLabel;

/**
 * Damage multiplier of `atkCls` attacking `defCls`.
 * @param {string} atkCls
 * @param {string} defCls
 * @returns {number}
 */
export function counter(atkCls, defCls) {
  const row = COUNTER[atkCls];
  if (!row) return 1;
  const v = row[defCls];
  return typeof v === 'number' ? v : 1;
}

/** Per-class presentation + which building/doctrine gates it. */
export const CLASS_META = {
  infantry: {
    key: 'infantry',
    name: 'Infantry',
    short: 'INF',
    icon: 'unit_infantry',
    color: '#9fb3c8',
    building: 'barracks',
    doctrine: DOCTRINE_BY_CLASS.infantry,
    beats: 'aircraft',
    losesTo: 'tank',
    desc: 'Cheap, fast to train, carries anti-air. Melts under armour.'
  },
  tank: {
    key: 'tank',
    name: 'Armour',
    short: 'TNK',
    icon: 'unit_tank',
    color: '#f0a500',
    building: 'tank_factory',
    doctrine: DOCTRINE_BY_CLASS.tank,
    beats: 'infantry',
    losesTo: 'aircraft',
    desc: 'The battering ram. Tough and hard-hitting, but naked to air attack.'
  },
  aircraft: {
    key: 'aircraft',
    name: 'Air Force',
    short: 'AIR',
    icon: 'unit_aircraft',
    color: '#4fd1c5',
    building: 'hangar',
    doctrine: DOCTRINE_BY_CLASS.aircraft,
    beats: 'tank',
    losesTo: 'infantry',
    desc: 'Fast and lethal against armour, but ground troops shoot back.'
  },
  artillery: {
    key: 'artillery',
    name: 'Artillery',
    short: 'ART',
    icon: 'unit_artillery',
    color: '#e2725b',
    building: 'artillery_range',
    doctrine: DOCTRINE_BY_CLASS.artillery,
    beats: null,
    losesTo: null,
    desc: 'Support guns: bonus damage to everything, fires last, dies fast.'
  }
};

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * Factory level required to train a given tier: 1, 4, 7, 10, 13, 16, 19, 22.
 * Inverse of buildings.tierForFactory.
 * @param {number} tier 1..8
 * @returns {number}
 */
export function FACTORY_LEVEL_FOR_TIER(tier) {
  const t = Math.max(1, Math.min(8, Math.floor(Number(tier) || 1)));
  return (t - 1) * 3 + 1;
}

/**
 * Doctrine tech level required to train a given tier: tier 1 is free,
 * tier N needs doctrine level N-1 (so tier 8 needs doctrine 7 of max 8).
 * @param {number} tier
 * @returns {number} 0 when no doctrine is needed
 */
export function DOCTRINE_LEVEL_FOR_TIER(tier) {
  const t = Math.max(1, Math.min(8, Math.floor(Number(tier) || 1)));
  return t - 1;
}

// ---------------------------------------------------------------------------
// Generation table — every one of the 32 units comes from these numbers, so all
// tiers exist and scale smoothly. Names are hand-written per tier.
// ---------------------------------------------------------------------------

const NAMES = {
  infantry: [
    'Militia', 'Rifle Squad', 'Assault Squad', 'AT Grenadiers',
    'Airborne Troopers', 'Marine Raiders', 'Spec-Ops Team', 'Vanguard Commandos'
  ],
  tank: [
    'Scout Car', 'Light Tank', 'Medium Tank', 'Assault Gun',
    'Heavy Tank', 'Main Battle Tank', 'Prototype MBT', 'Titan Armour'
  ],
  aircraft: [
    'Recon Drone', 'Scout Plane', 'Fighter', 'Attack Helicopter',
    'Strike Fighter', 'Gunship', 'Stealth Jet', 'Aerial Dominator'
  ],
  artillery: [
    'Mortar Team', 'Field Gun', 'Howitzer', 'Rocket Truck',
    'Self-Propelled Gun', 'MLRS Battery', 'Ballistic Battery', 'Siege Cannon'
  ]
};

const PREFIX = { infantry: 'inf', tank: 'tank', aircraft: 'air', artillery: 'arty' };

/** Level-1-tier baselines. Every higher tier is baseline * STAT_MULT^(tier-1). */
const BASE = {
  infantry: {
    hp: 120, atk: 24, def: 20, speed: 14, load: 25, upkeep: 1,
    cost: { oil: 20, steel: 60, rare: 0, food: 120 }, trainTime: 20
  },
  tank: {
    hp: 320, atk: 48, def: 46, speed: 22, load: 60, upkeep: 3,
    cost: { oil: 220, steel: 300, rare: 10, food: 80 }, trainTime: 45
  },
  aircraft: {
    hp: 200, atk: 66, def: 26, speed: 34, load: 40, upkeep: 4,
    cost: { oil: 400, steel: 220, rare: 90, food: 60 }, trainTime: 70
  },
  artillery: {
    hp: 180, atk: 78, def: 22, speed: 16, load: 45, upkeep: 3,
    cost: { oil: 260, steel: 380, rare: 70, food: 90 }, trainTime: 60
  }
};

const STAT_MULT = 1.42;   // hp / atk / def per tier
const COST_MULT = 1.8;    // resource cost per tier
const TIME_MULT = 1.38;   // training time per tier
const LOAD_MULT = 1.3;    // carry capacity per tier
const UPKEEP_MULT = 1.45; // food per hour per tier
const SPEED_MULT = 1.05;  // marginal speed gain per tier

/**
 * Canonical unit key for a class+tier, e.g. unitKey('tank', 3) === 'tank3'.
 * @param {string} cls
 * @param {number} tier
 * @returns {string}
 */
export function unitKey(cls, tier) {
  return (PREFIX[cls] || cls) + Math.max(1, Math.min(8, Math.floor(tier)));
}

function makeUnit(cls, tier) {
  const b = BASE[cls];
  const meta = CLASS_META[cls];
  const k = unitKey(cls, tier);
  const hp = Math.round(scaleAt(b.hp, STAT_MULT, tier));
  const atk = Math.round(scaleAt(b.atk, STAT_MULT, tier));
  const dfn = Math.round(scaleAt(b.def, STAT_MULT, tier));
  const doctrineLevel = DOCTRINE_LEVEL_FOR_TIER(tier);
  return {
    key: k,
    name: NAMES[cls][tier - 1],
    cls,
    tier,
    icon: meta.icon,
    desc: meta.desc,
    cost: scaleCost(b.cost, COST_MULT, tier),
    trainTime: timeAt(b.trainTime, TIME_MULT, tier),
    power: Math.round((atk + dfn) * 0.6 + hp * 0.25),
    hp,
    atk,
    def: dfn,
    speed: Math.round(scaleAt(b.speed, SPEED_MULT, tier)),
    load: Math.round(scaleAt(b.load, LOAD_MULT, tier)),
    upkeep: Math.round(scaleAt(b.upkeep, UPKEEP_MULT, tier) * 10) / 10,
    requires: {
      building: { key: meta.building, level: FACTORY_LEVEL_FOR_TIER(tier) },
      tech: doctrineLevel > 0 ? { key: meta.doctrine, level: doctrineLevel } : null
    }
  };
}

/**
 * UNITS[unitKey] = { key, name, cls, tier, icon, desc, cost, trainTime, power,
 *                    hp, atk, def, speed, load, upkeep,
 *                    requires:{ building:{key,level}, tech:{key,level}|null } }
 * Keys: inf1..inf8, tank1..tank8, air1..air8, arty1..arty8.
 */
export const UNITS = (() => {
  const out = {};
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c];
    for (let t = 1; t <= 8; t++) {
      const u = makeUnit(cls, t);
      out[u.key] = u;
    }
  }
  return out;
})();

/** All 32 unit keys, class by class, tier 1 -> 8. */
export const UNIT_KEYS = Object.keys(UNITS);

/** @param {string} key @returns {object|null} */
export function getUnit(key) {
  return UNITS[key] || null;
}

/** Every unit of a class, tier 1 -> 8. */
export function unitsByClass(cls) {
  return UNIT_KEYS.map((k) => UNITS[k]).filter((u) => u.cls === cls);
}

/** Every unit of a given tier, one per class. */
export function unitsOfTier(tier) {
  const t = Math.floor(Number(tier) || 0);
  return UNIT_KEYS.map((k) => UNITS[k]).filter((u) => u.tier === t);
}

/** Nominal power of `n` units of `key`. */
export function unitPower(key, n) {
  const u = UNITS[key];
  if (!u) return 0;
  return Math.round(u.power * Math.max(0, Math.floor(Number(n) || 0)));
}

/**
 * Resource cost to train `n` of a unit.
 * @param {string} key
 * @param {number} [n=1]
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function trainCost(key, n) {
  const u = UNITS[key];
  const out = {};
  if (!u) return out;
  const count = Math.max(1, Math.floor(Number(n) || 1));
  for (const r in u.cost) {
    if (!Object.prototype.hasOwnProperty.call(u.cost, r)) continue;
    out[r] = u.cost[r] * count;
  }
  return out;
}

/**
 * Base training time in SECONDS for `n` units (before train.speed bonuses).
 * @param {string} key
 * @param {number} [n=1]
 * @returns {number}
 */
export function trainTime(key, n) {
  const u = UNITS[key];
  if (!u) return 0;
  return u.trainTime * Math.max(1, Math.floor(Number(n) || 1));
}

/**
 * PURE predicate: may this unit be trained right now?
 * @param {string} unitKey e.g. 'tank4'
 * @param {number} hqLevel current HQ level
 * @param {Object<string,number>|Array<{key:string,level:number}>} buildings owned building levels
 * @param {Object<string,number>} tech researched tech levels (S.tech)
 * @returns {boolean}
 */
export function canTrain(unitKey, hqLevel, buildings, tech) {
  return missingUnitRequirements(unitKey, hqLevel, buildings, tech).length === 0;
}

/**
 * Unmet requirements for training a unit.
 * @param {string} key
 * @param {number} hqLevel
 * @param {Object<string,number>|Array<{key:string,level:number}>} buildings
 * @param {Object<string,number>} tech
 * @returns {{type:'building'|'tech', key:string, name:string, need:number, have:number}[]}
 */
export function missingUnitRequirements(key, hqLevel, buildings, tech) {
  const out = [];
  const u = UNITS[key];
  if (!u) return out;
  const levels = normalizeLevels(buildings);
  const owned = tech && typeof tech === 'object' ? tech : {};

  const rb = u.requires.building;
  const haveB = rb.key === 'hq'
    ? Math.floor(Number(hqLevel) || 0)
    : (levels[rb.key] || 0);
  if (haveB < rb.level) {
    out.push({
      type: 'building',
      key: rb.key,
      name: CLASS_META[u.cls].building === rb.key ? buildingLabel(rb.key) : rb.key,
      need: rb.level,
      have: haveB
    });
  }
  const rt = u.requires.tech;
  if (rt) {
    const haveT = Math.floor(Number(owned[rt.key]) || 0);
    if (haveT < rt.level) {
      const t = TECH[rt.key];
      out.push({
        type: 'tech',
        key: rt.key,
        name: t ? t.name : rt.key,
        need: rt.level,
        have: haveT
      });
    }
  }
  return out;
}

const BUILDING_LABELS = {
  barracks: 'Barracks',
  tank_factory: 'Tank Factory',
  hangar: 'Aircraft Hangar',
  artillery_range: 'Artillery Range'
};
function buildingLabel(k) {
  return BUILDING_LABELS[k] || k;
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

/**
 * Highest trainable tier of a class given its factory level.
 * Re-exported convenience wrapper over buildings.tierForFactory.
 * @param {string} cls
 * @param {number} factoryLevel
 * @returns {number} 0 when the factory is not built
 */
export function maxTierFor(cls, factoryLevel) {
  const lv = Math.floor(Number(factoryLevel) || 0);
  if (lv < 1 || !CLASS_META[cls]) return 0;
  return tierForFactory(lv);
}
