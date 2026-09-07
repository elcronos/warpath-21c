// js/data/tech.js — the research tree: 4 branches x 10 technologies = 40 entries.
// PURE DATA + pure helpers. Imports only ./balance.js.
// Exports: TECH, TECH_KEYS, BRANCHES, BRANCH_META, BONUS_KEYS, BONUS_META, DOCTRINE_BY_CLASS,
//          getTech, getTechCost, getTechTime, getTechBonus, techsInBranch,
//          techRequirementsMet, missingTechRequirements, maxTechLevel

import { costAt, timeAt, scaleCost } from './balance.js';

/**
 * The complete, closed enumeration of bonus keys any technology (or officer,
 * or building effect) may emit. engine/bonus.js sums these into getBonus(key).
 *
 * Combat keys are additive percentages expressed as fractions (0.05 = +5%):
 *   'atk.infantry' 'atk.tank' 'atk.aircraft' 'atk.artillery'
 *   'def.infantry' 'def.tank' 'def.aircraft' 'def.artillery'
 *   'hp.infantry'  'hp.tank'  'hp.aircraft'  'hp.artillery'
 * Economy / logistics keys, also fractions:
 *   'prod.oil' 'prod.steel' 'prod.rare' 'prod.food'  — resource output per hour
 *   'cap.storage'    — storage capacity
 *   'march.speed'    — march travel time reduction
 *   'train.speed'    — training time reduction
 *   'build.speed'    — construction time reduction
 *   'research.speed' — research time reduction
 *   'gather.speed'   — world-map gathering rate
 *   'load.capacity'  — how much a march can carry back
 *   'heal.speed'     — hospital healing rate
 */
export const BONUS_KEYS = [
  'atk.infantry', 'atk.tank', 'atk.aircraft', 'atk.artillery',
  'def.infantry', 'def.tank', 'def.aircraft', 'def.artillery',
  'hp.infantry', 'hp.tank', 'hp.aircraft', 'hp.artillery',
  'prod.oil', 'prod.steel', 'prod.rare', 'prod.food',
  'cap.storage', 'march.speed', 'train.speed', 'build.speed',
  'research.speed', 'gather.speed', 'load.capacity', 'heal.speed'
];

/** Label + formatting hint for every bonus key (UI use). */
export const BONUS_META = {
  'atk.infantry': { label: 'Infantry Attack', kind: 'pct' },
  'atk.tank': { label: 'Tank Attack', kind: 'pct' },
  'atk.aircraft': { label: 'Aircraft Attack', kind: 'pct' },
  'atk.artillery': { label: 'Artillery Attack', kind: 'pct' },
  'def.infantry': { label: 'Infantry Defence', kind: 'pct' },
  'def.tank': { label: 'Tank Defence', kind: 'pct' },
  'def.aircraft': { label: 'Aircraft Defence', kind: 'pct' },
  'def.artillery': { label: 'Artillery Defence', kind: 'pct' },
  'hp.infantry': { label: 'Infantry Health', kind: 'pct' },
  'hp.tank': { label: 'Tank Health', kind: 'pct' },
  'hp.aircraft': { label: 'Aircraft Health', kind: 'pct' },
  'hp.artillery': { label: 'Artillery Health', kind: 'pct' },
  'prod.oil': { label: 'Oil Output', kind: 'pct' },
  'prod.steel': { label: 'Steel Output', kind: 'pct' },
  'prod.rare': { label: 'Rare Earth Output', kind: 'pct' },
  'prod.food': { label: 'Food Output', kind: 'pct' },
  'cap.storage': { label: 'Storage Capacity', kind: 'pct' },
  'march.speed': { label: 'March Speed', kind: 'pct' },
  'train.speed': { label: 'Training Speed', kind: 'pct' },
  'build.speed': { label: 'Construction Speed', kind: 'pct' },
  'research.speed': { label: 'Research Speed', kind: 'pct' },
  'gather.speed': { label: 'Gathering Speed', kind: 'pct' },
  'load.capacity': { label: 'March Load', kind: 'pct' },
  'heal.speed': { label: 'Healing Speed', kind: 'pct' }
};

/** The four research branches. */
export const BRANCHES = ['economy', 'infantry', 'vehicles', 'aviation'];

export const BRANCH_META = {
  economy: { key: 'economy', name: 'Economy', icon: 'tech_economy', color: '#7bd66a' },
  infantry: { key: 'infantry', name: 'Infantry', icon: 'tech_infantry', color: '#9fb3c8' },
  vehicles: { key: 'vehicles', name: 'Vehicles', icon: 'tech_vehicles', color: '#f0a500' },
  aviation: { key: 'aviation', name: 'Aviation', icon: 'tech_aviation', color: '#4fd1c5' }
};

/** Unit class -> the doctrine technology whose level unlocks its tiers. */
export const DOCTRINE_BY_CLASS = {
  infantry: 'inf_doctrine',
  tank: 'veh_doctrine',
  aircraft: 'avi_doctrine',
  artillery: 'veh_artillery'
};

// ---------------------------------------------------------------------------
// Definition helper. Keeps all 40 entries in one uniform shape.
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @returns {object} tech definition
 */
function def(o) {
  return {
    key: o.key,
    name: o.name,
    branch: o.branch,
    maxLevel: o.maxLevel || 10,
    desc: o.desc,
    icon: o.icon || ('tech_' + o.branch),
    /** requires: { lab:<Research Lab level>, tech?:{key,level} } */
    requires: o.requires || { lab: 1 },
    cost: o.cost,
    costMult: o.costMult || 1.42,
    time: o.time,
    timeMult: o.timeMult || 1.4,
    /** @param {number} level @returns {Object<string,number>} */
    bonus: o.bonus
  };
}

/** one-bonus helper */
function b1(key, per) {
  return (l) => ({ [key]: round4(per * l) });
}
/** two-bonus helper */
function b2(k1, p1, k2, p2) {
  return (l) => ({ [k1]: round4(p1 * l), [k2]: round4(p2 * l) });
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// TECH — 40 technologies.
// ---------------------------------------------------------------------------

/**
 * TECH[key] = { key, name, branch, maxLevel, desc, icon, requires:{lab, tech?},
 *               cost:{oil,steel,rare,food}, costMult, time, timeMult, bonus(level) }
 * `cost` / `time` are the LEVEL-1 values; level N costs cost*costMult^(N-1).
 */
export const TECH = {
  // ================================================================ ECONOMY
  eco_drilling: def({
    key: 'eco_drilling', name: 'Deep Drilling', branch: 'economy',
    desc: 'Deeper bores and better pumps raise oil output.',
    requires: { lab: 1 },
    cost: { oil: 400, steel: 300, rare: 0, food: 200 }, time: 120,
    bonus: b1('prod.oil', 0.05)
  }),
  eco_smelting: def({
    key: 'eco_smelting', name: 'Blast Smelting', branch: 'economy',
    desc: 'Hotter furnaces and continuous casting raise steel output.',
    requires: { lab: 1 },
    cost: { oil: 300, steel: 400, rare: 0, food: 200 }, time: 120,
    bonus: b1('prod.steel', 0.05)
  }),
  eco_agriculture: def({
    key: 'eco_agriculture', name: 'Mechanised Agriculture', branch: 'economy',
    desc: 'Tractors and fertiliser raise food output.',
    requires: { lab: 1 },
    cost: { oil: 320, steel: 320, rare: 0, food: 120 }, time: 110,
    bonus: b1('prod.food', 0.05)
  }),
  eco_refining: def({
    key: 'eco_refining', name: 'Ore Refining', branch: 'economy',
    desc: 'Solvent extraction lifts rare earth yield from the same tonnage.',
    requires: { lab: 3, tech: { key: 'eco_drilling', level: 3 } },
    cost: { oil: 900, steel: 900, rare: 120, food: 400 }, time: 420,
    bonus: b1('prod.rare', 0.05)
  }),
  eco_logistics: def({
    key: 'eco_logistics', name: 'Depot Logistics', branch: 'economy',
    desc: 'Racking, palletising and stock control expand every storage cap.',
    requires: { lab: 4, tech: { key: 'eco_smelting', level: 3 } },
    cost: { oil: 1100, steel: 1400, rare: 150, food: 600 }, time: 540,
    bonus: b1('cap.storage', 0.06)
  }),
  eco_construction: def({
    key: 'eco_construction', name: 'Prefab Construction', branch: 'economy',
    desc: 'Prefabricated sections cut construction times across the base.',
    requires: { lab: 5, tech: { key: 'eco_logistics', level: 2 } },
    cost: { oil: 1800, steel: 2200, rare: 260, food: 900 }, time: 900,
    bonus: b1('build.speed', 0.03)
  }),
  eco_methodology: def({
    key: 'eco_methodology', name: 'Research Methodology', branch: 'economy',
    desc: 'Parallel test programmes shorten every research project.',
    requires: { lab: 6, tech: { key: 'eco_construction', level: 2 } },
    cost: { oil: 2600, steel: 2600, rare: 420, food: 1200 }, time: 1300,
    bonus: b1('research.speed', 0.03)
  }),
  eco_triage: def({
    key: 'eco_triage', name: 'Battlefield Triage', branch: 'economy',
    desc: 'Standardised triage returns the wounded to the line faster.',
    requires: { lab: 6, tech: { key: 'eco_agriculture', level: 3 } },
    cost: { oil: 2400, steel: 2400, rare: 380, food: 1600 }, time: 1200,
    bonus: b1('heal.speed', 0.05)
  }),
  eco_salvage: def({
    key: 'eco_salvage', name: 'Field Salvage', branch: 'economy',
    desc: 'Salvage crews strip resource nodes faster than raw manpower can.',
    requires: { lab: 7, tech: { key: 'eco_logistics', level: 4 } },
    cost: { oil: 3400, steel: 3400, rare: 560, food: 1600 }, time: 1800,
    bonus: b1('gather.speed', 0.05)
  }),
  eco_convoy: def({
    key: 'eco_convoy', name: 'Convoy Doctrine', branch: 'economy',
    desc: 'Bigger trucks and escorted columns carry more, faster.',
    requires: { lab: 8, tech: { key: 'eco_salvage', level: 2 } },
    cost: { oil: 4800, steel: 4400, rare: 800, food: 2200 }, time: 2600,
    bonus: b2('load.capacity', 0.06, 'march.speed', 0.02)
  }),

  // =============================================================== INFANTRY
  inf_doctrine: def({
    key: 'inf_doctrine', name: 'Infantry Doctrine', branch: 'infantry', maxLevel: 8,
    desc: 'Each level unlocks the next infantry tier and hardens the whole corps.',
    requires: { lab: 1 },
    cost: { oil: 500, steel: 500, rare: 40, food: 500 }, time: 180,
    costMult: 1.55, timeMult: 1.5,
    bonus: b2('atk.infantry', 0.02, 'hp.infantry', 0.02)
  }),
  inf_rifling: def({
    key: 'inf_rifling', name: 'Advanced Rifling', branch: 'infantry',
    desc: 'Tighter barrels and better sights raise infantry attack.',
    requires: { lab: 2 },
    cost: { oil: 500, steel: 700, rare: 60, food: 400 }, time: 200,
    bonus: b1('atk.infantry', 0.04)
  }),
  inf_armor_vest: def({
    key: 'inf_armor_vest', name: 'Composite Vests', branch: 'infantry',
    desc: 'Fragmentation vests raise infantry defence.',
    requires: { lab: 2 },
    cost: { oil: 500, steel: 800, rare: 60, food: 400 }, time: 200,
    bonus: b1('def.infantry', 0.04)
  }),
  inf_endurance: def({
    key: 'inf_endurance', name: 'Endurance Training', branch: 'infantry',
    desc: 'Conditioning and field rations raise infantry health.',
    requires: { lab: 3, tech: { key: 'inf_armor_vest', level: 2 } },
    cost: { oil: 900, steel: 900, rare: 110, food: 900 }, time: 380,
    bonus: b1('hp.infantry', 0.05)
  }),
  inf_drills: def({
    key: 'inf_drills', name: 'Accelerated Drills', branch: 'infantry',
    desc: 'Compressed basic training shortens every training order.',
    requires: { lab: 4 },
    cost: { oil: 1200, steel: 1200, rare: 160, food: 1100 }, time: 520,
    bonus: b1('train.speed', 0.03)
  }),
  inf_at_rockets: def({
    key: 'inf_at_rockets', name: 'Anti-Tank Rockets', branch: 'infantry',
    desc: 'Shaped-charge launchers let riflemen punch through armour.',
    requires: { lab: 5, tech: { key: 'inf_rifling', level: 3 } },
    cost: { oil: 2000, steel: 2400, rare: 340, food: 1200 }, time: 950,
    bonus: b1('atk.infantry', 0.05)
  }),
  inf_aa_training: def({
    key: 'inf_aa_training', name: 'Anti-Air Training', branch: 'infantry',
    desc: 'Shoulder-launched SAM drills make squads far harder to strafe.',
    requires: { lab: 6, tech: { key: 'inf_armor_vest', level: 4 } },
    cost: { oil: 2600, steel: 2600, rare: 460, food: 1400 }, time: 1200,
    bonus: b1('def.infantry', 0.05)
  }),
  inf_forced_march: def({
    key: 'inf_forced_march', name: 'Forced March', branch: 'infantry',
    desc: 'Lighter loads and route discipline speed every column up.',
    requires: { lab: 7, tech: { key: 'inf_endurance', level: 3 } },
    cost: { oil: 3200, steel: 3000, rare: 560, food: 2000 }, time: 1600,
    bonus: b1('march.speed', 0.025)
  }),
  inf_field_medics: def({
    key: 'inf_field_medics', name: 'Field Medics', branch: 'infantry',
    desc: 'Embedded medics stabilise casualties before evacuation.',
    requires: { lab: 8, tech: { key: 'inf_endurance', level: 5 } },
    cost: { oil: 4200, steel: 4000, rare: 760, food: 2800 }, time: 2200,
    bonus: b1('heal.speed', 0.05)
  }),
  inf_elite_corps: def({
    key: 'inf_elite_corps', name: 'Elite Corps', branch: 'infantry',
    desc: 'A standing cadre of veterans lifts the entire infantry arm.',
    requires: { lab: 10, tech: { key: 'inf_at_rockets', level: 5 } },
    cost: { oil: 7000, steel: 7000, rare: 1400, food: 4200 }, time: 3600,
    bonus: (l) => ({
      'atk.infantry': round4(0.04 * l),
      'def.infantry': round4(0.03 * l),
      'hp.infantry': round4(0.04 * l)
    })
  }),

  // =============================================================== VEHICLES
  veh_doctrine: def({
    key: 'veh_doctrine', name: 'Armour Doctrine', branch: 'vehicles', maxLevel: 8,
    desc: 'Each level unlocks the next tank tier and toughens the whole park.',
    requires: { lab: 3 },
    cost: { oil: 1400, steel: 1400, rare: 180, food: 700 }, time: 420,
    costMult: 1.55, timeMult: 1.5,
    bonus: b2('atk.tank', 0.02, 'hp.tank', 0.02)
  }),
  veh_guns: def({
    key: 'veh_guns', name: 'High-Velocity Guns', branch: 'vehicles',
    desc: 'Longer barrels and better propellant raise tank attack.',
    requires: { lab: 4 },
    cost: { oil: 1600, steel: 1800, rare: 240, food: 700 }, time: 620,
    bonus: b1('atk.tank', 0.04)
  }),
  veh_plating: def({
    key: 'veh_plating', name: 'Sloped Plating', branch: 'vehicles',
    desc: 'Sloped and spaced armour raises tank defence.',
    requires: { lab: 4 },
    cost: { oil: 1600, steel: 2000, rare: 240, food: 700 }, time: 620,
    bonus: b1('def.tank', 0.04)
  }),
  veh_engines: def({
    key: 'veh_engines', name: 'Turbo Diesels', branch: 'vehicles',
    desc: 'More power per tonne: tougher hulls that also move quicker.',
    requires: { lab: 5, tech: { key: 'veh_plating', level: 2 } },
    cost: { oil: 2400, steel: 2400, rare: 380, food: 900 }, time: 900,
    bonus: b2('hp.tank', 0.04, 'march.speed', 0.015)
  }),
  veh_assembly: def({
    key: 'veh_assembly', name: 'Assembly Line', branch: 'vehicles',
    desc: 'Moving-line production cuts training time for every unit.',
    requires: { lab: 6 },
    cost: { oil: 2800, steel: 3000, rare: 420, food: 1100 }, time: 1100,
    bonus: b1('train.speed', 0.03)
  }),
  veh_optics: def({
    key: 'veh_optics', name: 'Stabilised Optics', branch: 'vehicles',
    desc: 'Fire-control and stabilisers let tanks hit hard on the move.',
    requires: { lab: 7, tech: { key: 'veh_guns', level: 3 } },
    cost: { oil: 3600, steel: 3600, rare: 680, food: 1400 }, time: 1700,
    bonus: b1('atk.tank', 0.05)
  }),
  veh_artillery: def({
    key: 'veh_artillery', name: 'Artillery Doctrine', branch: 'vehicles', maxLevel: 8,
    desc: 'Each level unlocks the next artillery tier and improves gunnery.',
    requires: { lab: 8, tech: { key: 'veh_doctrine', level: 2 } },
    cost: { oil: 3800, steel: 4200, rare: 700, food: 1600 }, time: 1900,
    costMult: 1.55, timeMult: 1.5,
    bonus: b2('atk.artillery', 0.03, 'hp.artillery', 0.02)
  }),
  veh_ammo: def({
    key: 'veh_ammo', name: 'Improved Ammunition', branch: 'vehicles',
    desc: 'Base-bleed and submunition shells raise artillery attack.',
    requires: { lab: 9, tech: { key: 'veh_artillery', level: 2 } },
    cost: { oil: 4600, steel: 5000, rare: 900, food: 1900 }, time: 2400,
    bonus: b1('atk.artillery', 0.05)
  }),
  veh_barrels: def({
    key: 'veh_barrels', name: 'Reinforced Barrels', branch: 'vehicles',
    desc: 'Chrome-lined tubes and hardened carriages keep guns in action.',
    requires: { lab: 9, tech: { key: 'veh_artillery', level: 3 } },
    cost: { oil: 5000, steel: 5400, rare: 950, food: 2000 }, time: 2600,
    bonus: b2('def.artillery', 0.04, 'hp.artillery', 0.04)
  }),
  veh_spearhead: def({
    key: 'veh_spearhead', name: 'Armoured Spearhead', branch: 'vehicles',
    desc: 'Combined-arms breakthrough doctrine lifts the entire armoured arm.',
    requires: { lab: 10, tech: { key: 'veh_optics', level: 4 } },
    cost: { oil: 8000, steel: 8600, rare: 1600, food: 3200 }, time: 4200,
    bonus: (l) => ({
      'atk.tank': round4(0.04 * l),
      'def.tank': round4(0.03 * l),
      'hp.tank': round4(0.04 * l)
    })
  }),

  // =============================================================== AVIATION
  avi_doctrine: def({
    key: 'avi_doctrine', name: 'Air Doctrine', branch: 'aviation', maxLevel: 8,
    desc: 'Each level unlocks the next aircraft tier and improves the whole wing.',
    requires: { lab: 6 },
    cost: { oil: 3000, steel: 2600, rare: 600, food: 1200 }, time: 1400,
    costMult: 1.55, timeMult: 1.5,
    bonus: b2('atk.aircraft', 0.02, 'hp.aircraft', 0.02)
  }),
  avi_airframe: def({
    key: 'avi_airframe', name: 'Light Alloy Airframes', branch: 'aviation',
    desc: 'Stronger, lighter airframes raise aircraft health.',
    requires: { lab: 6 },
    cost: { oil: 3000, steel: 2800, rare: 620, food: 1100 }, time: 1400,
    bonus: b1('hp.aircraft', 0.04)
  }),
  avi_cannons: def({
    key: 'avi_cannons', name: 'Aircraft Cannons', branch: 'aviation',
    desc: 'Heavier wing armament raises aircraft attack.',
    requires: { lab: 6 },
    cost: { oil: 3200, steel: 3000, rare: 640, food: 1100 }, time: 1450,
    bonus: b1('atk.aircraft', 0.04)
  }),
  avi_avionics: def({
    key: 'avi_avionics', name: 'Defensive Avionics', branch: 'aviation',
    desc: 'Chaff, flares and jammers raise aircraft defence.',
    requires: { lab: 7, tech: { key: 'avi_airframe', level: 2 } },
    cost: { oil: 3800, steel: 3400, rare: 820, food: 1300 }, time: 1800,
    bonus: b1('def.aircraft', 0.04)
  }),
  avi_turbines: def({
    key: 'avi_turbines', name: 'Turbine Engines', branch: 'aviation',
    desc: 'Jet turbines get every column to the target sooner.',
    requires: { lab: 7, tech: { key: 'avi_doctrine', level: 2 } },
    cost: { oil: 4200, steel: 3600, rare: 900, food: 1400 }, time: 2000,
    bonus: b1('march.speed', 0.025)
  }),
  avi_ground_crew: def({
    key: 'avi_ground_crew', name: 'Ground Crew Training', branch: 'aviation',
    desc: 'Faster turnaround shortens every training order.',
    requires: { lab: 8 },
    cost: { oil: 4400, steel: 4000, rare: 950, food: 1600 }, time: 2200,
    bonus: b1('train.speed', 0.03)
  }),
  avi_recon: def({
    key: 'avi_recon', name: 'Aerial Recon', branch: 'aviation',
    desc: 'Overflights find the richest seams: gathering runs pay out faster.',
    requires: { lab: 8, tech: { key: 'avi_turbines', level: 2 } },
    cost: { oil: 4800, steel: 4200, rare: 1000, food: 1700 }, time: 2400,
    bonus: b1('gather.speed', 0.045)
  }),
  avi_ordnance: def({
    key: 'avi_ordnance', name: 'Precision Ordnance', branch: 'aviation',
    desc: 'Guided bombs and rockets sharply raise aircraft attack.',
    requires: { lab: 9, tech: { key: 'avi_cannons', level: 3 } },
    cost: { oil: 5600, steel: 5000, rare: 1300, food: 2000 }, time: 3000,
    bonus: b1('atk.aircraft', 0.05)
  }),
  avi_hangar_ops: def({
    key: 'avi_hangar_ops', name: 'Hangar Operations', branch: 'aviation',
    desc: 'Depot-level repair pushes damaged crews back into the fight.',
    requires: { lab: 9, tech: { key: 'avi_airframe', level: 4 } },
    cost: { oil: 5800, steel: 5200, rare: 1350, food: 2100 }, time: 3100,
    bonus: b1('heal.speed', 0.05)
  }),
  avi_air_superiority: def({
    key: 'avi_air_superiority', name: 'Air Superiority', branch: 'aviation',
    desc: 'Own the sky: a broad uplift to every aircraft in service.',
    requires: { lab: 10, tech: { key: 'avi_ordnance', level: 4 } },
    cost: { oil: 9000, steel: 8000, rare: 2200, food: 3400 }, time: 4800,
    bonus: (l) => ({
      'atk.aircraft': round4(0.04 * l),
      'def.aircraft': round4(0.03 * l),
      'hp.aircraft': round4(0.04 * l)
    })
  })
};

/** All 40 tech keys, grouped branch by branch in BRANCHES order. */
export const TECH_KEYS = Object.keys(TECH);

/** @param {string} key @returns {object|null} */
export function getTech(key) {
  return TECH[key] || null;
}

/** All tech definitions in a branch, in tree order. */
export function techsInBranch(branch) {
  return TECH_KEYS.map((k) => TECH[k]).filter((t) => t.branch === branch);
}

/** Max level a technology can reach. */
export function maxTechLevel(key) {
  const t = TECH[key];
  return t ? t.maxLevel : 0;
}

/**
 * Resource cost to research `level` of a technology.
 * @param {string} key
 * @param {number} level target level (1..maxLevel)
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function getTechCost(key, level) {
  const t = TECH[key];
  if (!t) return {};
  return scaleCost(t.cost, t.costMult, level);
}

/**
 * Base research time in SECONDS for `level` (before research.speed bonuses).
 * @param {string} key
 * @param {number} level
 * @returns {number}
 */
export function getTechTime(key, level) {
  const t = TECH[key];
  if (!t) return 0;
  return timeAt(t.time, t.timeMult, level);
}

/**
 * The bonuses a technology grants AT `level` (cumulative, not per-level delta).
 * @param {string} key
 * @param {number} level 0 = not researched -> {}
 * @returns {Object<string,number>}
 */
export function getTechBonus(key, level) {
  const t = TECH[key];
  const l = Math.floor(Number(level) || 0);
  if (!t || l < 1) return {};
  return t.bonus(Math.min(l, t.maxLevel)) || {};
}

/**
 * Are the prerequisites for researching `key` at `level` satisfied?
 * @param {string} key
 * @param {number} level target level
 * @param {number} labLevel current Research Lab level
 * @param {Object<string,number>} tech map of researched tech levels (S.tech)
 * @returns {boolean}
 */
export function techRequirementsMet(key, level, labLevel, tech) {
  return missingTechRequirements(key, level, labLevel, tech).length === 0;
}

/**
 * Unmet prerequisites for researching `key` at `level`.
 * @param {string} key
 * @param {number} level
 * @param {number} labLevel
 * @param {Object<string,number>} tech
 * @returns {{type:'lab'|'tech'|'level', key:string, name:string, need:number, have:number}[]}
 */
export function missingTechRequirements(key, level, labLevel, tech) {
  const out = [];
  const t = TECH[key];
  if (!t) return out;
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  const lab = Math.max(0, Math.floor(Number(labLevel) || 0));
  const owned = tech && typeof tech === 'object' ? tech : {};

  if (lv > t.maxLevel) {
    out.push({ type: 'level', key: t.key, name: t.name, need: t.maxLevel, have: lv });
    return out;
  }
  const req = t.requires || {};
  const needLab = Math.floor(req.lab || 1);
  if (lab < needLab) {
    out.push({ type: 'lab', key: 'lab', name: 'Research Lab', need: needLab, have: lab });
  }
  if (req.tech) {
    const pk = req.tech.key;
    const need = Math.floor(req.tech.level) || 1;
    const have = Math.floor(Number(owned[pk]) || 0);
    if (have < need) {
      const pt = TECH[pk];
      out.push({ type: 'tech', key: pk, name: pt ? pt.name : pk, need, have });
    }
  }
  return out;
}
